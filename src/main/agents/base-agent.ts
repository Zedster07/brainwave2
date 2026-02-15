/**
 * Base Agent — Abstract class that all agents extend
 *
 * Provides the think → act → report cycle, confidence tracking,
 * LLM access, event bus integration, memory context, and optional
 * agentic tool loop (executeWithTools) that any agent can opt into.
 */
import os from 'os'
import { randomUUID } from 'crypto'
import { readFile as fsReadFile } from 'fs/promises'
import { LLMFactory } from '../llm'
import type { LLMRequest, LLMResponse, AgentModelConfig } from '../llm'
import { getEventBus, type AgentType } from './event-bus'
import { getDatabase } from '../db/database'
import { getSoftEngine } from '../rules'
import { getPromptRegistry } from '../prompts'
import { countTokens, estimateRequestTokens, calculateBudget, formatTokenCount, type TokenBudget } from '../llm/token-counter'
import { compactContext, estimateFileRegistryTokens, estimateActionLogTokens, buildCompactionNotice, type FileRegistryEntry, type ToolResultEntry } from './context-compactor'
import { calculateCost, formatCost } from '../llm/pricing'
import { getMcpRegistry } from '../mcp'
import { getLocalToolProvider } from '../tools'
import { getAgentPermissions, filterToolsForAgent, canAgentCallTool, hasToolAccess } from '../tools/permissions'
import type { McpTool, McpToolCallResult } from '../mcp/types'
import type { ImageAttachment } from '@shared/types'
import type { BlackboardHandle } from './blackboard'
import { canDelegate, canDelegateAtDepth, buildDelegationToolDescription } from './delegation'
import { type CancellationToken, CancellationError } from './cancellation'

// ─── Types ──────────────────────────────────────────────────

export interface SubTask {
  id: string
  description: string
  assignedAgent: AgentType
  status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'retrying'
  dependencies: string[] // IDs of tasks that must complete first
  result?: unknown
  error?: string
  attempts: number
  maxAttempts: number
}

export interface TaskPlan {
  id: string
  taskId: string
  originalTask: string
  subTasks: SubTask[]
  estimatedComplexity: 'trivial' | 'simple' | 'moderate' | 'complex' | 'epic'
  requiredAgents: AgentType[]
}

export interface ToolingNeeds {
  webSearch?: boolean
  fileSystem?: boolean
  shellCommand?: boolean
  httpRequest?: boolean
}

export interface AgentContext {
  taskId: string
  planId?: string
  parentTask?: string
  relevantMemories?: string[]
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  siblingResults?: Map<string, AgentResult>
  images?: ImageAttachment[]
  blackboard?: BlackboardHandle
  /** Injected by AgentPool — allows agents to spawn sub-agents */
  delegateFn?: (agentType: AgentType, task: string) => Promise<AgentResult>
  /** Current delegation depth (0 = top-level, incremented per delegation) */
  delegationDepth?: number
  /** Tooling needs from triage — tells agents what capabilities to use */
  toolingNeeds?: ToolingNeeds
  /** Cancellation token — checked every iteration to support user abort */
  cancellationToken?: CancellationToken
}

export interface AgentResult {
  status: 'success' | 'partial' | 'failed'
  output: unknown
  confidence: number // 0.0 to 1.0
  reasoning?: string
  tokensIn: number
  tokensOut: number
  model: string
  promptVersion?: string // e.g. "v1:a4f2c9e1"
  suggestedMemories?: SuggestedMemory[]
  artifacts?: Artifact[]
  error?: string
  duration: number // ms
}

export interface SuggestedMemory {
  type: 'episodic' | 'semantic' | 'procedural'
  content: string
  importance: number
  tags: string[]
}

export interface Artifact {
  type: 'code' | 'text' | 'json' | 'file'
  name: string
  content: string
  language?: string
}

// ─── Base Agent ─────────────────────────────────────────────

export abstract class BaseAgent {
  abstract readonly type: AgentType
  abstract readonly capabilities: string[]
  abstract readonly description: string

  protected bus = getEventBus()
  protected db = getDatabase()
  /** Tracks the prompt version used in the most recent think() call */
  protected lastPromptVersion: string | undefined

  /** Get the system prompt for this agent */
  protected abstract getSystemPrompt(context: AgentContext): string

  /** Read the configured Brainwave home directory from settings (or fallback to ~/Brainwave) */
  protected getBrainwaveHomeDir(): string {
    const row = this.db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'brainwave_home_dir')
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value)
        if (typeof parsed === 'string' && parsed.trim()) return parsed.trim()
      } catch { /* fall through */ }
    }
    // Default fallback
    const os = require('os')
    const path = require('path')
    return path.join(os.homedir(), 'Brainwave')
  }

  /**
   * Execute a sub-task — the main entry point.
   * Override in agent subclasses for custom logic.
   * Default implementation: calls think() with the task description.
   * Includes self-correction: if the first attempt fails with an LLM error,
   * re-prompts with the error context for the model to fix its output.
   */
  async execute(task: SubTask, context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now()
    const modelConfig = LLMFactory.getAgentConfig(this.type)

    this.bus.emitEvent('agent:thinking', {
      agentType: this.type,
      taskId: context.taskId,
      model: modelConfig?.model ?? 'unknown',
    })

    try {
      const response = await this.think(task.description, context, {
        temperature: modelConfig?.temperature,
        maxTokens: modelConfig?.maxTokens,
      })

      const result: AgentResult = {
        status: 'success',
        output: response.content,
        confidence: this.assessConfidence(response),
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        model: response.model,
        promptVersion: this.lastPromptVersion,
        duration: Date.now() - startTime,
      }

      this.bus.emitEvent('agent:completed', {
        agentType: this.type,
        taskId: context.taskId,
        confidence: result.confidence,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      })

      this.logRun(task, context, result)
      return result
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)

      // Self-correction: if this looks like a content/parsing error (not provider outage),
      // try once more with the error appended as context for the model to fix
      if (this.isSelfCorrectableError(error)) {
        console.log(`[${this.type}] Attempting self-correction for: ${error.slice(0, 100)}`)
        try {
          const correctionPrompt = `${task.description}\n\n` +
            `IMPORTANT: Your previous attempt failed with this error:\n"${error}"\n\n` +
            `Please fix the issue and try again. Be more careful with your output format.`

          const response = await this.think(correctionPrompt, context, {
            temperature: Math.max(0.1, (modelConfig?.temperature ?? 0.7) - 0.2), // lower temperature for correction
            maxTokens: modelConfig?.maxTokens,
          })

          const result: AgentResult = {
            status: 'success',
            output: response.content,
            confidence: Math.min(this.assessConfidence(response), 0.6), // cap confidence for corrected outputs
            reasoning: 'Self-corrected after initial failure',
            tokensIn: response.tokensIn,
            tokensOut: response.tokensOut,
            model: response.model,
            promptVersion: this.lastPromptVersion,
            duration: Date.now() - startTime,
          }

          this.bus.emitEvent('agent:completed', {
            agentType: this.type,
            taskId: context.taskId,
            confidence: result.confidence,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            selfCorrected: true,
          })

          this.logRun(task, context, result)
          return result
        } catch (correctionErr) {
          // Self-correction also failed — fall through to failure path
          console.warn(`[${this.type}] Self-correction also failed:`, correctionErr)
        }
      }

      this.bus.emitEvent('agent:error', {
        agentType: this.type,
        taskId: context.taskId,
        error,
      })

      return {
        status: 'failed',
        output: null,
        confidence: 0,
        error,
        tokensIn: 0,
        tokensOut: 0,
        model: modelConfig?.model ?? 'unknown',
        duration: Date.now() - startTime,
      }
    }
  }

  /**
   * Check if an error is worth self-correcting (output format issues, JSON parse errors)
   * vs a hard infrastructure error (auth, network) that won't be fixed by re-prompting.
   */
  protected isSelfCorrectableError(error: string): boolean {
    const correctable = [
      'json',
      'parse',
      'unexpected token',
      'syntax',
      'invalid',
      'format',
      'expected',
      'missing',
      'property',
    ]
    const notCorrectable = [
      'api key',
      'auth',
      '401',
      '403',
      'circuit breaker',
      'rate_limit',
      'rate limit',
      '429',
      'timeout',
      'ETIMEDOUT',
      'ECONNRESET',
    ]
    const lower = error.toLowerCase()
    if (notCorrectable.some((p) => lower.includes(p))) return false
    return correctable.some((p) => lower.includes(p))
  }

  /**
   * Detect narration — when the LLM outputs prose instead of a JSON tool call.
   * Returns true if the content looks like natural language explanation rather
   * than a JSON object. This is used by the anti-narration system to redirect
   * without burning the correction budget.
   */
  protected isNarration(content: string): boolean {
    const trimmed = content.trim()
    // If it starts with { it's attempting JSON (even if malformed) — not narration
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false
    // If it contains a JSON object, the rescue system will handle it
    if (/\{\s*"tool"\s*:/.test(trimmed) || /\{\s*"done"\s*:/.test(trimmed)) return false
    // Short responses might be edge cases — don't classify as narration
    if (trimmed.length < 50) return false
    // If it has sentence-like patterns (capital letter + words + period/question mark)
    // and NO JSON-like content, it's narration
    const hasSentences = /[A-Z][a-z]+\s+\w+.*[.!?]/.test(trimmed)
    const hasMultipleLines = trimmed.split('\n').filter(l => l.trim().length > 0).length > 2
    return hasSentences || hasMultipleLines
  }

  /**
   * Think — send a prompt to the LLM and get a response.
   * Builds the full prompt with system instructions + memory context.
   */
  protected async think(
    userMessage: string,
    context: AgentContext,
    overrides?: { temperature?: number; maxTokens?: number; responseFormat?: 'text' | 'json' }
  ): Promise<LLMResponse> {
    const adapter = LLMFactory.getForAgent(this.type)
    const modelConfig = LLMFactory.getAgentConfig(this.type)

    const systemPrompt = this.getSystemPrompt(context)

    // Register/update prompt in the registry for version tracking
    const registry = getPromptRegistry()
    const promptName = `${this.type}-system`
    if (!registry.has(promptName)) {
      registry.register(promptName, 'v1', () => systemPrompt)
    }
    this.lastPromptVersion = registry.getVersion(promptName)?.version

    // Inject soft rules as constraints
    const constraintBlock = getSoftEngine().buildConstraintBlock(this.type)

    // Build memory context string
    const memoryContext = context.relevantMemories?.length
      ? `\n\nRELEVANT MEMORIES:\n${context.relevantMemories.join('\n---\n')}`
      : ''

    const request: LLMRequest = {
      model: modelConfig?.model,
      system: systemPrompt + constraintBlock,
      user: userMessage,
      context: memoryContext || undefined,
      temperature: overrides?.temperature ?? modelConfig?.temperature ?? 0.7,
      maxTokens: overrides?.maxTokens ?? modelConfig?.maxTokens,
      responseFormat: overrides?.responseFormat,
      images: context.images?.map((img) => ({ data: img.data, mimeType: img.mimeType })),
      signal: context.cancellationToken?.signal,
    }

    console.log(`[${this.type}] think() → model=${request.model} | format=${request.responseFormat ?? 'text'} | prompt=${userMessage.slice(0, 120)}...`)

    const response = await adapter.complete(request)

    console.log(`[${this.type}] think() ← ${response.tokensIn}+${response.tokensOut} tokens | finish=${response.finishReason} | response=${response.content.slice(0, 200)}...`)

    return response
  }

  /**
   * Think and expect JSON output.
   * Parses the JSON response automatically.
   * Handles markdown code block wrapping (```json ... ```) that some models produce.
   */
  protected async thinkJSON<T = unknown>(
    userMessage: string,
    context: AgentContext,
    overrides?: { temperature?: number; maxTokens?: number }
  ): Promise<{ parsed: T; raw: LLMResponse }> {
    const response = await this.think(userMessage, context, {
      ...overrides,
      responseFormat: 'json',
    })

    const cleaned = this.extractJSON(response.content)
    console.log(`[${this.type}] thinkJSON raw (first 300 chars): ${response.content.slice(0, 300)}`)

    try {
      const parsed = JSON.parse(cleaned) as T
      return { parsed, raw: response }
    } catch (parseErr) {
      console.error(`[${this.type}] thinkJSON parse failed. Raw content:\n${response.content.slice(0, 500)}`)
      throw parseErr
    }
  }

  /**
   * Extract JSON from a response that might be wrapped in markdown code blocks.
   * Handles: raw JSON, ```json ... ```, ``` ... ```, or JSON embedded in text.
   */
  protected extractJSON(content: string): string {
    const trimmed = content.trim()

    // 1. Try raw JSON first (starts with { or [)
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return trimmed
    }

    // 2. Try markdown code block: ```json ... ``` or ``` ... ```
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim()
    }

    // 3. Try to find a JSON object or array anywhere in the response
    const jsonObjMatch = trimmed.match(/\{[\s\S]*\}/)
    if (jsonObjMatch) {
      return jsonObjMatch[0]
    }

    const jsonArrMatch = trimmed.match(/\[[\s\S]*\]/)
    if (jsonArrMatch) {
      return jsonArrMatch[0]
    }

    // 4. Return as-is — JSON.parse will throw a descriptive error
    return trimmed
  }

  /**
   * Assess confidence of a response.
   * Subclasses can override with more sophisticated logic.
   */
  protected assessConfidence(response: LLMResponse): number {
    // Base heuristic: if the model finished cleanly, moderate confidence
    if (response.finishReason === 'stop') return 0.7
    if (response.finishReason === 'length') return 0.4 // truncated
    return 0.5
  }

  /** Log the agent run to the database for tracking and reflection */
  protected logRun(task: SubTask, context: AgentContext, result: AgentResult): void {
    try {
      this.db.run(
        `INSERT INTO agent_runs (id, agent_type, task_id, status, input, output, llm_model, tokens_in, tokens_out, cost_usd, confidence, prompt_version, started_at, completed_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), CURRENT_TIMESTAMP, ?)`,
        randomUUID(),
        this.type,
        context.taskId,
        result.status === 'success' ? 'completed' : 'failed',
        JSON.stringify({ description: task.description }),
        JSON.stringify(result.output),
        result.model,
        result.tokensIn,
        result.tokensOut,
        calculateCost(result.model, result.tokensIn, result.tokensOut),
        result.confidence,
        result.promptVersion ?? null,
        `-${result.duration / 1000} seconds`,
        result.error ?? null
      )
    } catch (err) {
      console.error(`[${this.type}] Failed to log run:`, err)
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  AGENTIC TOOL LOOP — Shared infrastructure for all agents
  // ═══════════════════════════════════════════════════════════

  /**
   * Build the tool catalog section for an agent's system prompt.
   * Filters tools by the agent's permission tier and formats them
   * with instructions on the tool-call JSON protocol.
   *
   * Agents that want tool access should call this from getSystemPrompt()
   * and append the result. Executor has its own elaborate version.
   */
  protected buildToolSection(): string {
    if (!hasToolAccess(this.type)) return ''

    const registry = getMcpRegistry()
    const localProvider = getLocalToolProvider()
    const allTools = [...localProvider.getTools(), ...registry.getAllTools()]
    const allowed = filterToolsForAgent(this.type, allTools)

    if (allowed.length === 0) return ''

    const lines = allowed.map((t) => {
      const schema = t.inputSchema as { properties?: Record<string, unknown> }
      const params = Object.keys(schema.properties ?? {}).join(', ')
      return `- ${t.key}: ${t.description}${params ? ` (params: ${params})` : ''}`
    })

    const permConfig = getAgentPermissions(this.type)
    const maxSteps = permConfig.maxSteps ?? 5

    // Include delegation tool if this agent can delegate
    const delegationDesc = buildDelegationToolDescription(this.type)
    const delegationSection = delegationDesc
      ? `\n\n## Agent Delegation\nYou can delegate sub-tasks to specialist agents:\n${delegationDesc}\n\nCall it like any other tool:\n{ "tool": "delegate_to_agent", "args": { "agent": "<type>", "task": "<description>" } }`
      : ''

    return `

## Available Tools
${lines.join('\n')}

## Tool Call Protocol
To call a tool, respond with ONLY a JSON object:
{ "tool": "<tool_key>", "args": { ... } }

- tool_key format is "serverId::toolName" (e.g. "local::file_read", "local::web_search", or "abc123::search")
- args must match the tool's input schema
- You can call ONE tool per response — NEVER output multiple tool calls
- Your entire response MUST be a single JSON object — NO text before or after it
- After seeing the tool result, decide: call another tool OR provide your final answer
- You have a maximum of ${maxSteps} tool calls per task
- For file paths, always use absolute paths
${delegationSection}

When the task is FULLY complete and you have the final answer, respond with:
{ "done": true, "summary": "your final answer here" }

Do NOT respond with plain text. You MUST always output a JSON object.`
  }

  /**
   * Execute a task using the agentic tool loop.
   *
   * This is the shared multi-step loop: think → parse tool call → execute → repeat.
   * Any agent can call this from their execute() override when they need tool access.
   * Tool access is gated by the permission system — agents can only call tools
   * they're allowed to use.
   *
   * If no tools are available (tier=none or no tools discovered), falls back
   * to a single think() call and returns the text result.
   */
  protected async executeWithTools(
    task: SubTask,
    context: AgentContext
  ): Promise<AgentResult> {
    const startTime = Date.now()
    const modelConfig = LLMFactory.getAgentConfig(this.type)
    const permConfig = getAgentPermissions(this.type)
    const registry = getMcpRegistry()
    const localProvider = getLocalToolProvider()

    // Get only the tools this agent is allowed to use
    const allTools = [...localProvider.getTools(), ...registry.getAllTools()]
    const allowedTools = filterToolsForAgent(this.type, allTools)

    // If no tools available, fall back to single LLM call
    if (allowedTools.length === 0) {
      console.log(`[${this.type}] executeWithTools: No tools available, falling back to think()`)
      const response = await this.think(task.description, context)
      return {
        status: 'success',
        output: response.content,
        confidence: this.assessConfidence(response),
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        model: response.model,
        promptVersion: this.lastPromptVersion,
        duration: Date.now() - startTime,
      }
    }

    this.bus.emitEvent('agent:thinking', {
      agentType: this.type,
      taskId: context.taskId,
      model: modelConfig?.model ?? 'unknown',
    })

    let totalTokensIn = 0
    let totalTokensOut = 0
    let model = modelConfig?.model ?? 'unknown'
    const artifacts: Artifact[] = []
    const toolResults: Array<{ tool: string; success: boolean; content: string }> = []

    // No hard step cap — agents run until done, timed out, or stuck in a loop
    const TIMEOUT_MS = permConfig.timeoutMs ?? 5 * 60 * 1000
    const MAX_LOOP_REPEATS = 3 // same tool+args repeated this many times = loop
    const MAX_TOOL_FREQUENCY = 8 // same tool name (any args) called this many times = stuck
    const MAX_CONSECUTIVE_SAME = 5 // same tool called N times in a row (different args) = stuck
    const ABSOLUTE_MAX_STEPS = 25 // safety valve — reduced from 50, should never be reached
    let corrections = 0
    const MAX_CORRECTIONS = 2
    const toolCallHistory: Array<{ tool: string; argsHash: string }> = []
    const toolFrequency: Map<string, number> = new Map() // track per-tool call count
    let stuckWarningGiven = false // soft-loop warning before hard break
    let compactionCount = 0 // how many times we've compacted this run
    let compactionNotice = '' // injected after compaction

    // ── File registry: tracks files we've read for smart dedup & structured prompts ──
    let fileRegistry = new Map<string, FileRegistryEntry>()
    const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase()
    const getReadPath = (args: Record<string, unknown>): string | null =>
      (args.path as string) ?? (args.file_path as string) ?? null

    /**
     * Build a structured history block that separates FILE CONTENTS from ACTION LOG.
     * This makes it much easier for the model to find and reference file content
     * instead of hunting through a linear step dump.
     */
    const buildHistoryBlock = (): string => {
      let block = ''

      // FILES section — deduplicated file contents in one clear place
      if (fileRegistry.size > 0) {
        block += `== FILES IN MEMORY (${fileRegistry.size} file${fileRegistry.size > 1 ? 's' : ''}) — do NOT re-read ==\n`
        for (const [filePath, data] of fileRegistry) {
          block += `\n--- ${filePath} (step ${data.step}) ---\n${data.content}\n`
        }
        block += '\n'
      }

      // Compact action log — file reads reference FILES section, other results show preview
      block += `== ACTION LOG (${toolResults.length} actions) ==\n`
      for (let i = 0; i < toolResults.length; i++) {
        const t = toolResults[i]
        const tName = t.tool.split('::').pop() ?? t.tool
        if (['file_read', 'read_file'].includes(tName) && t.success && !t.content.startsWith('ALREADY')) {
          block += `  ${i + 1}. ${tName} → OK (see FILES section above)\n`
        } else if (t.content.startsWith('ALREADY READ')) {
          block += `  ${i + 1}. ${tName} → SKIPPED (duplicate)\n`
        } else if (tName === 'shell_execute' || tName === 'file_edit' || tName === 'file_write' || tName === 'file_create') {
          const preview = t.content.split('\n')[0].slice(0, 200)
          block += `  ${i + 1}. ${tName} → ${t.success ? 'OK' : 'FAIL'}: ${preview}\n`
        } else {
          const preview = t.content.split('\n').slice(0, 3).join(' ').slice(0, 200)
          block += `  ${i + 1}. ${tName} → ${t.success ? 'OK' : 'FAIL'}: ${preview}\n`
        }
      }

      return block
    }

    const contextLimit = calculateBudget(model, 0).contextLimit
    console.log(`[${this.type}] executeWithTools | taskId=${context.taskId} | model=${model} | tools=${allowedTools.length} | timeout=${Math.round(TIMEOUT_MS / 1000)}s | contextLimit=${formatTokenCount(contextLimit)}`)
    console.log(`[${this.type}] Task: "${task.description.slice(0, 200)}"`)

    try {
      // Build context from prior subtask results
      let priorContext = ''
      if (context.siblingResults && context.siblingResults.size > 0) {
        const priorLines: string[] = []
        for (const [stepId, result] of context.siblingResults) {
          if (result.status === 'success' || result.status === 'partial') {
            const output = typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output)
            priorLines.push(`- ${stepId}: ${output}`)
          }
        }
        if (priorLines.length > 0) {
          priorContext = `\n\nPRIOR STEPS ALREADY COMPLETED (use this context — do NOT redo these):\n${priorLines.join('\n')}\n`
        }
      }

      const parentContext = context.parentTask
        ? `\nORIGINAL USER REQUEST: "${context.parentTask}"\n`
        : ''

      // Inject recent conversation history so agents can resolve references like "try again"
      let historyContext = ''
      if (context.conversationHistory && context.conversationHistory.length > 0) {
        // Keep last 6 messages (3 exchanges) — pass full content since we're well within context limits
        const recent = context.conversationHistory.slice(-6)
        const lines = recent.map((msg) =>
          `${msg.role === 'user' ? 'User' : 'Brainwave'}: ${msg.content}`
        ).join('\n')
        historyContext = `\n\nRECENT CONVERSATION (use this to understand references like "try again", "do that", etc.):\n${lines}\n`
      }

      // Inject shared blackboard context from other agents
      let blackboardContext = ''
      if (context.blackboard) {
        blackboardContext = context.blackboard.board.formatForPrompt(
          context.blackboard.planId,
          this.type,
          context.taskId
        )
      }

      let currentPrompt =
        `TASK: ${task.description}\n${parentContext}${historyContext}${priorContext}${blackboardContext}\n` +
        `Respond with a JSON tool call to begin working on this task. ` +
        `For file/directory operations, ALWAYS use local:: tools (e.g. local::file_read, local::file_write, local::create_directory). ` +
        `Do NOT respond with text. You MUST output a JSON object.`

      // ── Step 0: Forced sequential-thinking planning phase ──
      // Find the sequential_thinking MCP tool and call it automatically
      // so every agent "thinks before acting"
      let planningContext = ''
      const seqThinkTool = registry.getAllTools().find(
        t => t.name === 'sequential_thinking' || t.name === 'sequentialthinking'
      )
      if (seqThinkTool) {
        try {
          console.log(`[${this.type}] Step 0: Auto-calling sequential_thinking for task planning`)
          this.bus.emitEvent('agent:acting', {
            agentType: this.type,
            taskId: context.taskId,
            action: 'Planning with sequential thinking...',
          })

          const planThought =
            `Analyze this task and create a step-by-step plan before taking action.\n\n` +
            `Task: ${task.description}\n\n` +
            (parentContext ? `Original user request context: ${context.parentTask}\n\n` : '') +
            (context.toolingNeeds?.webSearch || context.toolingNeeds?.httpRequest
              ? `This is a SEARCH/RESEARCH task. You MUST coordinate two tool sources:\n` +
                `- brave_web_search: Use for DISCOVERY (finding URLs, getting search result summaries)\n` +
                `- Bright Data MCP (scrape_as_markdown, scrape_batch): Use for EXTRACTION (getting full page content from URLs)\n` +
                `Plan a workflow that uses brave_web_search first to find the best URLs, then Bright Data to extract detailed content.\n` +
                `NEVER call the same search tool more than 4-5 times. If results are poor, STOP and report what you found.\n\n`
              : '') +
            `Consider:\n` +
            `1. What is the user actually asking for?\n` +
            `2. What tools would be most effective?\n` +
            `3. What is the most efficient sequence of tool calls?\n` +
            `4. What could go wrong and how to handle it?\n` +
            `5. When should I stop and report results?`

          const thinkResult = await registry.callTool(seqThinkTool.key, {
            thought: planThought,
            nextThoughtNeeded: false,
            thoughtNumber: 1,
            totalThoughts: 1,
          })

          if (thinkResult.success && thinkResult.content) {
            planningContext = `\n\n== PLANNING ANALYSIS (from sequential thinking) ==\n${thinkResult.content}\n`
            console.log(`[${this.type}] Step 0: sequential_thinking completed (${thinkResult.duration}ms)`)
          }

          this.bus.emitEvent('agent:tool-result', {
            agentType: this.type,
            taskId: context.taskId,
            tool: seqThinkTool.key,
            success: thinkResult.success,
            summary: 'Task planning completed',
            step: 0,
          })
        } catch (err) {
          console.warn(`[${this.type}] Step 0: sequential_thinking failed, continuing without planning:`, err)
        }
      } else {
        console.warn(`[${this.type}] sequential_thinking MCP tool not found — skipping planning phase`)
      }

      // Inject planning context into the initial prompt
      if (planningContext) {
        currentPrompt =
          `TASK: ${task.description}\n${parentContext}${historyContext}${priorContext}${blackboardContext}${planningContext}\n` +
          `Use the planning analysis above to guide your approach. ` +
          `For file/directory operations, ALWAYS use local:: tools (e.g. local::file_read, local::file_write, local::create_directory). ` +
          `Respond with a JSON tool call to begin working on this task. ` +
          `Do NOT respond with text. You MUST output a JSON object.`
      }

      let step = 0
      let loopDetected = false
      while (step < ABSOLUTE_MAX_STEPS) {
        step++

        // ── Cancellation check ──
        if (context.cancellationToken?.isCancelled) {
          console.log(`[${this.type}] Cancelled at step ${step}`)
          const anySuccess = toolResults.some((t) => t.success)
          this.bus.emitEvent('agent:error', {
            agentType: this.type,
            taskId: context.taskId,
            error: 'Task cancelled by user',
          })
          return this.buildToolResult(
            anySuccess ? 'partial' : 'failed',
            anySuccess
              ? `Task cancelled after ${step - 1} step(s). Partial results:\n` +
                toolResults.filter(t => t.success).slice(-3).map(t => `${t.tool}: ${t.content.slice(0, 200)}`).join('\n')
              : 'Task cancelled by user before any results were obtained.',
            anySuccess ? 0.4 : 0.1,
            totalTokensIn, totalTokensOut, model, startTime, artifacts
          )
        }

        // Check overall timeout
        if (Date.now() - startTime > TIMEOUT_MS) {
          const anySuccess = toolResults.some((t) => t.success)
          this.bus.emitEvent('agent:error', {
            agentType: this.type,
            taskId: context.taskId,
            error: `Timed out after ${Math.round((Date.now() - startTime) / 1000)}s`,
          })
          return this.buildToolResult(
            anySuccess ? 'partial' : 'failed',
            `Timed out after ${Math.round((Date.now() - startTime) / 1000)}s. ` +
            (toolResults.length > 0
              ? `Completed ${toolResults.length} tool call(s). Last results:\n` +
                toolResults.slice(-2).map((t) => `${t.tool}: ${t.content}`).join('\n')
              : 'No tool calls completed.'),
            anySuccess ? 0.5 : 0.2,
            totalTokensIn, totalTokensOut, model, startTime, artifacts
          )
        }

        this.bus.emitEvent('agent:acting', {
          agentType: this.type,
          taskId: context.taskId,
          action: `Step ${step}: ${step === 1 ? 'Analyzing task...' : 'Deciding next action...'}`,
        })

        // ── Token budget check & auto-compaction ──
        if (step > 1 && fileRegistry.size > 0) {
          const promptEstimate = countTokens(currentPrompt) + countTokens(this.getSystemPrompt(context))
          const budget = calculateBudget(model, promptEstimate)

          if (budget.shouldCompact && compactionCount < 3) {
            const tokensToFree = Math.ceil(budget.currentUsage * 0.3) // try to free 30%
            console.log(
              `[${this.type}] Step ${step}: Context at ${(budget.usageRatio * 100).toFixed(0)}% (${formatTokenCount(budget.currentUsage)}/${formatTokenCount(budget.inputBudget)}) — compacting...`
            )

            const compactionResult = compactContext(
              fileRegistry,
              toolResults,
              tokensToFree,
              step
            )

            if (compactionResult.tokensFreed > 0) {
              fileRegistry = compactionResult.fileRegistry
              toolResults.length = 0
              toolResults.push(...compactionResult.toolResults)
              compactionCount++
              compactionNotice = buildCompactionNotice(compactionResult)

              console.log(
                `[${this.type}] Compaction #${compactionCount}: freed ${formatTokenCount(compactionResult.tokensFreed)} tokens (level ${compactionResult.levelApplied})`
              )

              this.bus.emitEvent('agent:acting', {
                agentType: this.type,
                taskId: context.taskId,
                action: `Context compacted: freed ${formatTokenCount(compactionResult.tokensFreed)} tokens`,
              })

              // Rebuild prompt with compacted context
              let latestBlackboard = ''
              if (context.blackboard) {
                latestBlackboard = context.blackboard.board.formatForPrompt(
                  context.blackboard.planId, this.type, context.taskId
                )
              }

              currentPrompt =
                `TASK: ${task.description}\n${parentContext}${historyContext}\n` +
                buildHistoryBlock() + '\n' +
                compactionNotice +
                (latestBlackboard ? `== SHARED CONTEXT FROM OTHER AGENTS ==${latestBlackboard}\n\n` : '') +
                `== INSTRUCTIONS ==\n` +
                `Continue working until the task is complete.\n` +
                `CRITICAL RULES:\n` +
                `- All files you've read are in the FILES IN MEMORY section above. Reference them DIRECTLY — do NOT re-read.\n` +
                `- For file/directory operations, ALWAYS use local:: tools.\n` +
                `- DO NOT ask the user for permission. Just DO IT.\n`
            }
          } else if (step % 5 === 0) {
            // Periodic budget logging (every 5 steps)
            console.log(
              `[${this.type}] Step ${step}: Token budget: ${formatTokenCount(budget.currentUsage)}/${formatTokenCount(budget.inputBudget)} (${(budget.usageRatio * 100).toFixed(0)}%) | files=${fileRegistry.size} | actions=${toolResults.length}`
            )
          }
        }

        const response = await this.think(currentPrompt, context, {
          temperature: modelConfig?.temperature ?? 0.1,
          maxTokens: modelConfig?.maxTokens,
          responseFormat: 'json',
        })

        totalTokensIn += response.tokensIn
        totalTokensOut += response.tokensOut
        model = response.model

        // Check for done signal
        const doneSignal = this.parseDoneSignal(response.content)
        if (doneSignal) {
          console.log(`[${this.type}] Done signal at step ${step}: "${doneSignal.slice(0, 200)}..."`)
          const anySuccess = toolResults.some((t) => t.success)

          // Write final summary to blackboard for downstream agents
          if (context.blackboard) {
            context.blackboard.board.write(
              context.blackboard.planId,
              'final-summary',
              doneSignal,
              this.type,
              context.taskId
            )
          }

          this.bus.emitEvent('agent:completed', {
            agentType: this.type,
            taskId: context.taskId,
            confidence: anySuccess ? 0.9 : 0.7,
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            toolsCalled: toolResults.map((t) => t.tool),
          })

          return this.buildToolResult(
            anySuccess ? 'success' : (toolResults.length > 0 ? 'partial' : 'success'),
            doneSignal,
            anySuccess ? 0.9 : 0.7,
            totalTokensIn, totalTokensOut, model, startTime, artifacts
          )
        }

        // Parse tool call
        const toolCall = this.parseToolCall(response.content)

        if (!toolCall) {
          // ── Anti-narration: detect prose output and redirect without burning corrections ──
          if (this.isNarration(response.content) && corrections === 0) {
            console.warn(`[${this.type}] Step ${step}: Anti-narration triggered — LLM output prose instead of JSON tool call`)
            this.bus.emitEvent('agent:acting', {
              agentType: this.type,
              taskId: context.taskId,
              action: `Anti-narration: redirecting to tool call format`,
            })
            currentPrompt =
              `TASK: ${task.description}\n${parentContext}${historyContext}\n` +
              (toolResults.length > 0 ? buildHistoryBlock() + '\n' : '') +
              `== CRITICAL: WRONG OUTPUT FORMAT ==\n` +
              `You just responded with plain text/prose instead of a JSON tool call.\n` +
              `Your narration has been DISCARDED. The user will NOT see it.\n\n` +
              `You are in TOOL MODE. You MUST respond with ONE of these JSON formats:\n\n` +
              `1. To call a tool:\n{ "tool": "local::file_read", "args": { "path": "/some/file" } }\n\n` +
              `2. To signal completion:\n{ "done": true, "summary": "your final answer here" }\n\n` +
              `If you have enough information to answer the question, use format 2.\n` +
              `If you need more data, use format 1 to call a tool.\n` +
              `DO NOT output any text outside a JSON object.`
            continue
          }

          console.warn(`[${this.type}] Step ${step}: No tool call or done signal. Raw: ${response.content.slice(0, 200)}`)
          if (corrections < MAX_CORRECTIONS) {
            corrections++
            this.bus.emitEvent('agent:acting', {
              agentType: this.type,
              taskId: context.taskId,
              action: `Sending correction ${corrections}/${MAX_CORRECTIONS}`,
            })
            currentPrompt =
              `TASK: ${task.description}\n${parentContext}${historyContext}\n` +
              (toolResults.length > 0
                ? buildHistoryBlock() + '\n'
                : '') +
              `== ERROR: INVALID RESPONSE FORMAT ==\n` +
              `Your last response was not a valid tool call or completion signal.\n` +
              `You responded with: ${response.content.slice(0, 200)}\n\n` +
              `You MUST respond with EXACTLY one of these JSON formats:\n\n` +
              `To call a tool:\n{ "tool": "local::file_read", "args": { "path": "/some/file" } }\n\n` +
              `To signal task completion:\n{ "done": true, "summary": "your final answer here" }\n\n` +
              `IMPORTANT: For file/directory operations, use local:: tools (local::file_read, local::file_write, local::file_create, local::create_directory, etc.).\n` +
              `Do NOT include any text outside the JSON object.`
            continue
          }

          // Too many corrections — one last attempt: brute-force extract a tool call
          // from ALL balanced JSON objects in the response. This catches the case where
          // the model emits prose + CSS snippets + a valid tool-call JSON at the end.
          for (const candidate of this.extractAllJsonObjects(response.content)) {
            try {
              const parsed = JSON.parse(candidate)
              if (parsed.tool && typeof parsed.tool === 'string') {
                console.log(`[${this.type}] Rescued tool call from invalid-format response: ${parsed.tool}`)
                // Don't return — execute this tool call by assigning it and continuing
                // We need to re-parse, so just set currentPrompt to re-trigger with a note
                // Actually, simpler: just inject it back into the loop
                const rescuedCall = { tool: parsed.tool as string, args: (parsed.args as Record<string, unknown>) ?? {} }
                const rescuedPerm = canAgentCallTool(this.type, rescuedCall.tool)
                if (rescuedPerm.allowed) {
                  corrections = 0 // reset so the loop can continue
                  // Push a synthetic history entry noting the rescue
                  toolResults.push({
                    tool: 'system',
                    success: true,
                    content: `Extracted tool call "${rescuedCall.tool}" from mixed prose+JSON response`,
                  })
                  // We can't easily re-enter the tool execution part of the loop from here,
                  // so rebuild the prompt with the rescued tool call as instruction
                  currentPrompt =
                    `TASK: ${task.description}\n${parentContext}${historyContext}\n` +
                    buildHistoryBlock() + '\n' +
                    `== RECOVERED TOOL CALL ==\n` +
                    `Your previous response contained a valid tool call but was wrapped in prose.\n` +
                    `The tool call was: ${JSON.stringify(rescuedCall)}\n` +
                    `Please re-emit ONLY this JSON (no surrounding text):\n` +
                    `{ "tool": "${rescuedCall.tool}", "args": ${JSON.stringify(rescuedCall.args)} }`
                  break // break out of the !toolCall block to continue the main while loop
                }
              }
            } catch { /* not valid JSON, try next */ }
          }
          // If we broke out with a rescued call, corrections was reset to 0 — continue the loop
          if (corrections === 0) continue

          // Truly no tool call found — treat response as final
          const anySuccess = toolResults.some((t) => t.success)
          this.bus.emitEvent('agent:completed', {
            agentType: this.type,
            taskId: context.taskId,
            confidence: anySuccess ? 0.85 : 0.7,
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            toolsCalled: toolResults.map((t) => t.tool),
          })
          return this.buildToolResult(
            anySuccess ? 'success' : (toolResults.length > 0 ? 'partial' : 'success'),
            response.content,
            anySuccess ? 0.85 : 0.7,
            totalTokensIn, totalTokensOut, model, startTime, artifacts
          )
        }

        // ── Permission check ──
        const perm = canAgentCallTool(this.type, toolCall.tool)
        if (!perm.allowed) {
          console.warn(`[${this.type}] BLOCKED tool call: ${toolCall.tool} — ${perm.reason}`)
          toolResults.push({
            tool: toolCall.tool,
            success: false,
            content: `PERMISSION DENIED: ${perm.reason}`,
          })
          currentPrompt =
            `TASK: ${task.description}\n${parentContext}${historyContext}\n` +
            buildHistoryBlock() + '\n' +
            `== PERMISSION DENIED ==\n` +
            `You tried to call "${toolCall.tool}" but you don't have permission.\n` +
            `Reason: ${perm.reason}\n` +
            `Try using a local:: tool instead (e.g. local::file_read, local::file_write) which have NO path restrictions, or signal completion if you can answer without it.`
          continue
        }

        // ── Duplicate read interception (path-based, not just exact args) ──
        const argsHash = JSON.stringify(toolCall.args ?? {})
        const toolBaseName = toolCall.tool.split('::').pop() ?? toolCall.tool
        const callSig = `${toolCall.tool}:${argsHash}`

        const isReadOp = ['file_read', 'directory_list', 'read_file', 'read_multiple_files'].includes(toolBaseName)
        if (isReadOp) {
          const readPath = getReadPath(toolCall.args)
          const normalizedRead = readPath ? normPath(readPath) : null
          const cachedFile = normalizedRead ? fileRegistry.get(normalizedRead) : null

          // If we already have this file in the registry, serve from cache (transparent cache hit)
          if (cachedFile) {
            // If the model is requesting a line range, extract it from the full cached content
            const startLine = toolCall.args.start_line as number | undefined
            const endLine = toolCall.args.end_line as number | undefined
            let excerpt = cachedFile.content
            if (startLine || endLine) {
              const lines = cachedFile.content.split('\n')
              const s = Math.max(0, (startLine ?? 1) - 1)
              const e = Math.min(lines.length, endLine ?? lines.length)
              excerpt = `[Lines ${s + 1}-${e} of ${lines.length} total]\n` + lines.slice(s, e).join('\n')
            }

            console.log(`[${this.type}] Step ${step}: Cache hit — serving "${readPath}" from registry (step ${cachedFile.step})`)
            // Return the ACTUAL content so the model can verify edits and see current state
            toolResults.push({
              tool: toolCall.tool,
              success: true,
              content: excerpt,
            })
            toolCallHistory.push({ tool: toolCall.tool, argsHash })

            this.bus.emitEvent('agent:tool-result', {
              agentType: this.type,
              taskId: context.taskId,
              tool: toolCall.tool,
              success: true,
              summary: `Read from cache (${cachedFile.content.split('\n').length} lines)`,
              step,
            })
            // Normal continuation — no scary blocking messages
            continue
          }

          // Fallback: exact args match for non-file reads (directory_list, etc.)
          const priorResult = toolResults.find(t =>
            t.tool === toolCall.tool && t.success &&
            toolCallHistory.some(h => `${h.tool}:${h.argsHash}` === callSig)
          )
          if (priorResult) {
            console.log(`[${this.type}] Step ${step}: Cache hit — exact match for ${toolBaseName}`)
            // Return the actual cached content for transparency
            toolResults.push({
              tool: toolCall.tool,
              success: true,
              content: priorResult.content,
            })
            toolCallHistory.push({ tool: toolCall.tool, argsHash })

            this.bus.emitEvent('agent:tool-result', {
              agentType: this.type,
              taskId: context.taskId,
              tool: toolCall.tool,
              success: true,
              summary: `Read from cache`,
              step,
            })
            // Normal continuation — no blocking messages
            continue
          }
        }

        // ── Loop detection (multi-strategy) ──
        toolCallHistory.push({ tool: toolCall.tool, argsHash })

        // Update per-tool frequency
        const freq = (toolFrequency.get(toolBaseName) ?? 0) + 1
        toolFrequency.set(toolBaseName, freq)

        // Strategy 1: Exact match — same tool + identical args N times
        const exactRepeatCount = toolCallHistory.filter(h => `${h.tool}:${h.argsHash}` === callSig).length
        if (exactRepeatCount >= MAX_LOOP_REPEATS) {
          loopDetected = true
          console.warn(`[${this.type}] Loop detected (exact match): "${toolBaseName}" called ${exactRepeatCount}× with identical args`)
          break
        }

        // Strategy 2: Per-tool frequency — same tool name called too many times total
        if (freq >= MAX_TOOL_FREQUENCY) {
          if (!stuckWarningGiven) {
            stuckWarningGiven = true
            console.warn(`[${this.type}] Stuck warning: "${toolBaseName}" called ${freq} times total — injecting warning`)
            // Don't execute this call — instead warn the agent
            toolResults.push({
              tool: toolCall.tool,
              success: false,
              content: `STUCK DETECTION: You have called "${toolBaseName}" ${freq} times. You may be looping. Consider whether the task is already complete and signal { "done": true, "summary": "..." }, or try a completely different approach.`,
            })
            this.bus.emitEvent('agent:tool-result', {
              agentType: this.type,
              taskId: context.taskId,
              tool: toolCall.tool,
              success: false,
              summary: `Stuck warning: "${toolBaseName}" called ${freq}× — should change approach`,
              step,
            })
            currentPrompt =
              `TASK: ${task.description}\n${parentContext}${historyContext}\n` +
              buildHistoryBlock() + '\n' +
              `== ⚠️ HIGH TOOL USAGE ==\n` +
              `You have called "${toolBaseName}" ${freq} times. Check if you're making progress.\n` +
              `If the task is done, signal completion: { "done": true, "summary": "..." }\n` +
              `If not done, try a different approach or tool.`
            continue
          }
          // Already warned — hard break
          loopDetected = true
          console.warn(`[${this.type}] Loop detected (frequency): "${toolBaseName}" called ${freq}× — already warned, breaking`)
          break
        }

        // Strategy 3: Consecutive same-tool — same tool N times in a row with different args
        if (toolCallHistory.length >= MAX_CONSECUTIVE_SAME) {
          const lastN = toolCallHistory.slice(-MAX_CONSECUTIVE_SAME)
          const allSameTool = lastN.every(h => h.tool === toolCall.tool)
          if (allSameTool) {
            if (!stuckWarningGiven) {
              stuckWarningGiven = true
              console.warn(`[${this.type}] Stuck warning: "${toolBaseName}" called ${MAX_CONSECUTIVE_SAME}× consecutively — injecting warning`)
              // Don't execute — warn first
              toolResults.push({
                tool: toolCall.tool,
                success: false,
                content: `STUCK DETECTION: You have called "${toolBaseName}" ${MAX_CONSECUTIVE_SAME} times in a row. You are stuck in a loop. STOP and either try a completely different approach or signal completion.`,
              })
              this.bus.emitEvent('agent:tool-result', {
                agentType: this.type,
                taskId: context.taskId,
                tool: toolCall.tool,
                success: false,
                summary: `Stuck warning: ${toolBaseName} called ${MAX_CONSECUTIVE_SAME}× consecutively`,
                step,
              })
              currentPrompt =
                `TASK: ${task.description}\n${parentContext}${historyContext}\n` +
                buildHistoryBlock() + '\n' +
                `== ⚠️ STUCK DETECTION ==\n` +
                `You called "${toolBaseName}" ${MAX_CONSECUTIVE_SAME} times in a row. You are looping.\n` +
                `STOP calling "${toolBaseName}" and either:\n` +
                `1. Try a COMPLETELY DIFFERENT tool\n` +
                `2. Signal completion: { "done": true, "summary": "what you found so far" }\n\n` +
                `Do NOT call "${toolBaseName}" again.`
              continue
            }
            // Already warned — hard break
            loopDetected = true
            console.warn(`[${this.type}] Loop detected (consecutive): "${toolBaseName}" called ${MAX_CONSECUTIVE_SAME}× in a row — already warned, breaking`)
            break
          }
        }

        // ── Handle delegation tool call ──
        if (toolCall.tool === 'delegate_to_agent') {
          const targetAgent = toolCall.args?.agent as AgentType | undefined
          const delegatedTask = toolCall.args?.task as string | undefined

          if (!targetAgent || !delegatedTask) {
            toolResults.push({
              tool: 'delegate_to_agent',
              success: false,
              content: 'INVALID ARGS: "delegate_to_agent" requires { "agent": "<type>", "task": "<description>" }',
            })
          } else if (!context.delegateFn) {
            toolResults.push({
              tool: 'delegate_to_agent',
              success: false,
              content: 'DELEGATION UNAVAILABLE: No delegation handler is available in this execution context.',
            })
          } else if (!canDelegateAtDepth(context.delegationDepth ?? 0)) {
            toolResults.push({
              tool: 'delegate_to_agent',
              success: false,
              content: `DELEGATION DEPTH EXCEEDED: Maximum delegation depth reached. Complete the task with your own capabilities.`,
            })
          } else {
            const delegationPerm = canDelegate(this.type, targetAgent)
            if (!delegationPerm.allowed) {
              toolResults.push({
                tool: 'delegate_to_agent',
                success: false,
                content: `DELEGATION DENIED: ${delegationPerm.reason}`,
              })
            } else {
              console.log(`[${this.type}] Step ${step}: Delegating to ${targetAgent}: "${delegatedTask.slice(0, 150)}"`)

              this.bus.emitEvent('agent:acting', {
                agentType: this.type,
                taskId: context.taskId,
                action: `Delegating to ${targetAgent} (step ${step})`,
              })

              try {
                const delegationResult = await context.delegateFn(targetAgent, delegatedTask)
                const outputStr = typeof delegationResult.output === 'string'
                  ? delegationResult.output
                  : JSON.stringify(delegationResult.output)

                toolResults.push({
                  tool: `delegate_to_agent:${targetAgent}`,
                  success: delegationResult.status === 'success' || delegationResult.status === 'partial',
                  content: outputStr,
                })

                totalTokensIn += delegationResult.tokensIn
                totalTokensOut += delegationResult.tokensOut

                // Write delegated result to blackboard
                if (context.blackboard && (delegationResult.status === 'success' || delegationResult.status === 'partial')) {
                  context.blackboard.board.write(
                    context.blackboard.planId,
                    `delegated-${targetAgent}-result`,
                    outputStr,
                    this.type,
                    context.taskId
                  )
                }

                artifacts.push({
                  type: 'json',
                  name: `delegation-${targetAgent}-step${step}`,
                  content: JSON.stringify({
                    agent: targetAgent,
                    status: delegationResult.status,
                    confidence: delegationResult.confidence,
                    output: outputStr,
                  }, null, 2),
                })
              } catch (err) {
                toolResults.push({
                  tool: `delegate_to_agent:${targetAgent}`,
                  success: false,
                  content: `DELEGATION FAILED: ${err instanceof Error ? err.message : String(err)}`,
                })
              }
            }
          }

          // Emit delegation result for live streaming to UI
          const delegEventResult = toolResults[toolResults.length - 1]
          const delegAgent = targetAgent ?? 'agent'
          const delegSummary = delegEventResult.success
            ? `Delegated to ${delegAgent} — completed`
            : `Delegation to ${delegAgent} failed`
          this.bus.emitEvent('agent:tool-result', {
            agentType: this.type,
            taskId: context.taskId,
            tool: delegEventResult.tool,
            success: delegEventResult.success,
            summary: delegSummary,
            step,
          })

          // Build context for next iteration after delegation
          let delegBlackboard = ''
          if (context.blackboard) {
            delegBlackboard = context.blackboard.board.formatForPrompt(
              context.blackboard.planId, this.type, context.taskId
            )
          }

          const lastDelegResult = toolResults[toolResults.length - 1]
          currentPrompt =
            `TASK: ${task.description}\n${parentContext}${historyContext}\n` +
            buildHistoryBlock() + '\n' +
            (delegBlackboard ? `== SHARED CONTEXT FROM OTHER AGENTS ==${delegBlackboard}\n\n` : '') +
            `== INSTRUCTIONS ==\n` +
            `Continue working until the task is complete.\n` +
            (lastDelegResult.success
              ? `The delegation to ${targetAgent ?? 'agent'} succeeded. Analyze the result:\n` +
                `- If the task is FULLY complete, respond with: { "done": true, "summary": "your answer" }\n` +
                `- If NOT complete, call another tool or delegate again.`
              : `The delegation FAILED. Try a different approach:\n` +
                `- Use your own tools instead, or try a different agent.\n` +
                `Respond with a new tool call JSON.`)
          continue
        }

        // ── Execute the tool ──
        console.log(`[${this.type}] Step ${step}: Calling ${toolCall.tool} args=${JSON.stringify(toolCall.args).slice(0, 200)}`)

        // Extract reasoning from the model response (prose before the JSON tool call)
        const reasoning = this.extractReasoning(response.content)
        if (reasoning) {
          this.bus.emitEvent('agent:acting', {
            agentType: this.type,
            taskId: context.taskId,
            action: `💭 ${reasoning}`,
          })
        }

        const result = toolCall.tool.startsWith('local::')
          ? await localProvider.callTool(toolCall.tool.split('::')[1], toolCall.args)
          : await registry.callTool(toolCall.tool, toolCall.args)

        console.log(`[${this.type}] Step ${step}: ${toolCall.tool} → ${result.success ? 'SUCCESS' : 'FAILED'} | ${result.content.slice(0, 200)}`)

        toolResults.push({
          tool: toolCall.tool,
          success: result.success,
          content: result.content,
        })

        // Auto-write successful tool results to the shared blackboard
        if (result.success && context.blackboard) {
          const toolShortName = toolCall.tool.split('::').pop() ?? toolCall.tool
          context.blackboard.board.write(
            context.blackboard.planId,
            `${toolShortName}-result`,
            result.content,
            this.type,
            context.taskId
          )
        }

        artifacts.push({
          type: 'json',
          name: `tool-result-${toolCall.tool.split('::').pop()}-step${step}`,
          content: JSON.stringify(result, null, 2),
        })

        // Emit tool-result for live streaming to UI
        this.bus.emitEvent('agent:tool-result', {
          agentType: this.type,
          taskId: context.taskId,
          tool: toolCall.tool,
          success: result.success,
          summary: this.summarizeForUI(toolCall.tool, toolCall.args, result),
          step,
        })

        // Update file registry for smart dedup and structured prompts
        if (result.success) {
          if (isReadOp) {
            const readPath = getReadPath(toolCall.args)
            if (readPath) {
              const hasRange = toolCall.args.start_line || toolCall.args.end_line
              const existing = fileRegistry.get(normPath(readPath))
              // Store full reads; only store range reads if we don't have the full file yet
              if (!existing || !hasRange) {
                fileRegistry.set(normPath(readPath), { content: result.content, step })
              }
            }
          }

          // ── After file_edit/file_write/file_create: refresh registry with new content ──
          // This prevents the dedup system from serving stale content after edits
          const isWriteOp = ['file_edit', 'file_write', 'file_create'].includes(toolBaseName)
          if (isWriteOp) {
            const writePath = getReadPath(toolCall.args)
            if (writePath) {
              try {
                const freshContent = await fsReadFile(writePath, 'utf-8')
                fileRegistry.set(normPath(writePath), { content: freshContent, step })
                console.log(`[${this.type}] Step ${step}: Registry refreshed for "${writePath}" after ${toolBaseName}`)
              } catch (err) {
                // If we can't re-read (e.g. file_delete edge case), evict stale entry
                fileRegistry.delete(normPath(writePath))
                console.warn(`[${this.type}] Step ${step}: Could not refresh registry for "${writePath}":`, err)
              }
            }
          }

          // Detect `type "file"` shell commands as implicit file reads
          if (toolBaseName === 'shell_execute') {
            const cmd = String(toolCall.args.command ?? '')
            const typeMatch = cmd.match(/^type\s+"?([^"]+)"?$/i)
            if (typeMatch) {
              fileRegistry.set(normPath(typeMatch[1].trim()), { content: result.content, step })
            }
          }
        }

        // Refresh blackboard context (other agents may have written since we started)
        let latestBlackboard = ''
        if (context.blackboard) {
          latestBlackboard = context.blackboard.board.formatForPrompt(
            context.blackboard.planId,
            this.type,
            context.taskId
          )
        }

        currentPrompt =
          `TASK: ${task.description}\n${parentContext}${historyContext}\n` +
          buildHistoryBlock() + '\n' +
          (latestBlackboard ? `== SHARED CONTEXT FROM OTHER AGENTS ==${latestBlackboard}\n\n` : '') +
          `== INSTRUCTIONS ==\n` +
          `Continue working until the task is complete.\n` +
          `CRITICAL RULES:\n` +
          `- All files you've read are in the FILES IN MEMORY section above. Reference them DIRECTLY — do NOT re-read.\n` +
          `- For file/directory operations, ALWAYS use local:: tools (local::file_read, local::file_write, local::file_create, local::create_directory, etc.).\n` +
          `- DO NOT ask the user for permission. DO NOT say "would you like me to...". Just DO IT.\n` +
          `- To MODIFY a file, call local::file_edit with the old_string/new_string NOW. The file content is in FILES IN MEMORY.\n\n` +
          (result.success
            ? `The last tool call succeeded. Analyze the result:\n` +
              `- If the task is FULLY complete, respond with: { "done": true, "summary": "your answer" }\n` +
              `- If NOT complete, call another tool NOW. Do NOT stop to explain.`
            : `The last tool call FAILED. Try a DIFFERENT approach immediately:\n` +
              `- Different tool, different arguments, different strategy.\n` +
              `Respond with a new tool call JSON.`)
      }

      // Loop detected or safety-valve hit — request a summary
      const stopReason = loopDetected
        ? `Loop detected — you kept calling the same tool(s) repeatedly without making progress.`
        : `Safety limit reached (${ABSOLUTE_MAX_STEPS} steps).`

      // Build a compact recap — just tool names and outcomes, not full content
      const compactRecap = toolResults.slice(-10).map((t, i) => {
        const tName = t.tool.split('::').pop() ?? t.tool
        const firstLine = t.content.split('\n')[0].slice(0, 100)
        return `  ${i + 1}. ${tName} → ${t.success ? 'OK' : 'FAIL'}: ${firstLine}`
      }).join('\n')

      const summaryPrompt =
        `Original task: ${task.description}\n\n` +
        `${stopReason} Here's what happened (${toolResults.length} steps, last 10):\n` +
        compactRecap +
        `\n\nIMPORTANT: You have NO more tool calls. Do NOT output any JSON or tool calls.\n` +
        `Write a SHORT, DIRECT answer for the user (3-5 sentences max):\n` +
        `- What you found or accomplished\n` +
        `- What specific edit/fix is still needed (be precise: which file, which line, what change)\n\n` +
        `CRITICAL: Do NOT ask the user questions. Do NOT say "Would you like me to...", "Shall I...", "Let me know if...", or "If you'd like me to...".\n` +
        `Be concise. State facts. No JSON. No tool calls.`

      const summaryResponse = await this.think(summaryPrompt, context, {
        temperature: 0.3,
        maxTokens: modelConfig?.maxTokens,
        responseFormat: 'text',
      })
      totalTokensIn += summaryResponse.tokensIn
      totalTokensOut += summaryResponse.tokensOut

      // Strip any lingering tool-call JSON the model may have sneaked in
      let summaryText = summaryResponse.content
      const toolCallMatch = summaryText.match(/\{\s*"tool"\s*:/)
      if (toolCallMatch && toolCallMatch.index !== undefined) {
        summaryText = summaryText.slice(0, toolCallMatch.index).trim()
        if (!summaryText) {
          summaryText = 'The task could not be fully completed within the available steps. Please try again or break the task into smaller steps.'
        }
      }

      const anySuccess = toolResults.some((t) => t.success)

      this.bus.emitEvent('agent:completed', {
        agentType: this.type,
        taskId: context.taskId,
        confidence: anySuccess ? 0.6 : 0.3,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        toolsCalled: toolResults.map((t) => t.tool),
      })

      return this.buildToolResult(
        anySuccess ? 'partial' : 'failed',
        summaryText,
        anySuccess ? 0.6 : 0.3,
        totalTokensIn, totalTokensOut, model, startTime, artifacts
      )
    } catch (err) {
      // Handle cancellation gracefully — not a real error
      if (CancellationError.is(err) || (err instanceof Error && err.name === 'AbortError')) {
        console.log(`[${this.type}] Aborted (cancellation)`)
        const anySuccess = toolResults.some((t) => t.success)
        return this.buildToolResult(
          anySuccess ? 'partial' : 'failed',
          anySuccess
            ? 'Task cancelled. Partial results available.'
            : 'Task cancelled by user.',
          anySuccess ? 0.4 : 0.1,
          totalTokensIn, totalTokensOut, model, startTime, artifacts
        )
      }

      const error = err instanceof Error ? err.message : String(err)
      this.bus.emitEvent('agent:error', {
        agentType: this.type,
        taskId: context.taskId,
        error,
      })
      return this.buildToolResult(
        'failed', null, 0,
        totalTokensIn, totalTokensOut, model, startTime, artifacts, error
      )
    }
  }

  // ─── Tool Parsing Helpers ─────────────────────────────────

  /** Parse a tool call from the LLM's response */
  protected parseToolCall(
    content: string
  ): { tool: string; args: Record<string, unknown> } | null {
    if (this.parseDoneSignal(content)) return null

    const extractTool = (parsed: Record<string, unknown>): { tool: string; args: Record<string, unknown> } | null => {
      if (parsed.tool && typeof parsed.tool === 'string') {
        return { tool: parsed.tool, args: (parsed.args as Record<string, unknown>) ?? {} }
      }
      if (parsed.done === true && typeof parsed.summary === 'string') {
        try {
          const nested = JSON.parse(parsed.summary)
          if (nested.tool && typeof nested.tool === 'string') {
            console.log(`[${this.type}] Extracted tool call from done-wrapped summary`)
            return { tool: nested.tool, args: nested.args ?? {} }
          }
        } catch { /* not a nested tool call */ }
      }
      return null
    }

    // 1. Try full content as JSON
    try {
      const result = extractTool(JSON.parse(content))
      if (result) return result
    } catch { /* not pure JSON */ }

    // 2. Try markdown code block
    const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (jsonMatch) {
      try {
        const result = extractTool(JSON.parse(jsonMatch[1]))
        if (result) return result
      } catch { /* not valid JSON in code block */ }
    }

    // 3. Handle mixed prose + tool calls, [TOOL_CALL] markers
    const chunks = content.split(/\[TOOL_CALL\]/i)
    for (const chunk of chunks) {
      // Try ALL balanced JSON objects in this chunk, not just the first one.
      // Prose often contains CSS/code like `{ opacity: 1; }` before the real tool call.
      for (const extracted of this.extractAllJsonObjects(chunk)) {
        try {
          const result = extractTool(JSON.parse(extracted))
          if (result) {
            if (chunks.length > 1) {
              console.log(`[${this.type}] Extracted tool call from ${chunks.length} [TOOL_CALL] chunks`)
            }
            return result
          }
        } catch { /* not valid JSON — try next balanced object */ }
      }
    }

    return null
  }

  /** Parse a done signal { "done": true, "summary": "..." } from the LLM's response */
  protected parseDoneSignal(content: string): string | null {
    const extractDone = (parsed: Record<string, unknown>): string | null => {
      if (parsed.done === true && typeof parsed.summary === 'string') {
        if (this.looksLikeToolCall(parsed.summary)) {
          console.log(`[${this.type}] Rejecting done signal — summary is an embedded tool call`)
          return null
        }
        return parsed.summary
      }
      return null
    }

    if (/\[TOOL_CALL\]/i.test(content)) return null

    try {
      return extractDone(JSON.parse(content))
    } catch {
      const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      if (jsonMatch) {
        try {
          const result = extractDone(JSON.parse(jsonMatch[1]))
          if (result) return result
        } catch { /* ignore */ }
      }

      const extracted = this.extractFirstJsonObject(content)
      if (extracted) {
        try {
          const result = extractDone(JSON.parse(extracted))
          if (result) return result
        } catch { /* ignore */ }
      }
    }
    return null
  }

  /**
   * Extract ALL balanced JSON-like objects from a string that may contain
   * surrounding prose. Yields each `{...}` candidate so the caller can
   * try JSON.parse on each until one is valid.
   * This fixes the bug where CSS snippets like `{ opacity: 1; }` appear
   * before the actual tool-call JSON, causing the old extractFirstJsonObject
   * to grab the wrong block.
   */
  protected *extractAllJsonObjects(text: string): Generator<string> {
    let searchFrom = 0
    while (searchFrom < text.length) {
      const start = text.indexOf('{', searchFrom)
      if (start === -1) return

      let depth = 0
      let inString = false
      let escape = false
      let foundEnd = -1
      for (let i = start; i < text.length; i++) {
        const ch = text[i]
        if (escape) { escape = false; continue }
        if (ch === '\\' && inString) { escape = true; continue }
        if (ch === '"' && !escape) { inString = !inString; continue }
        if (inString) continue
        if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          if (depth === 0) {
            foundEnd = i
            break
          }
        }
      }

      if (foundEnd !== -1) {
        yield text.slice(start, foundEnd + 1)
        searchFrom = foundEnd + 1
      } else {
        // Unbalanced — skip past this '{'
        searchFrom = start + 1
      }
    }
  }

  /** Legacy helper — returns the first balanced JSON object (used by parseDoneSignal) */
  protected extractFirstJsonObject(text: string): string | null {
    for (const obj of this.extractAllJsonObjects(text)) {
      return obj
    }
    return null
  }

  /** Quick check: does this string look like a tool call JSON? */
  protected looksLikeToolCall(s: string): boolean {
    try {
      const p = JSON.parse(s.trim())
      return !!(p.tool && typeof p.tool === 'string')
    } catch {
      return false
    }
  }

  /**
   * Extract the model's reasoning/explanation text from its response.
   * The model often outputs prose before the JSON tool call — this grabs that.
   * Returns a clean 1-2 sentence summary, or null if nothing meaningful.
   */
  protected extractReasoning(content: string): string | null {
    if (!content) return null

    // Find the first '{' that starts a JSON object (the tool call)
    let braceDepth = 0
    let jsonStart = -1
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '{') {
        if (braceDepth === 0) jsonStart = i
        braceDepth++
      } else if (content[i] === '}') {
        braceDepth--
        if (braceDepth === 0 && jsonStart >= 0) {
          // Validate it's actually JSON with a "tool" key
          const candidate = content.slice(jsonStart, i + 1)
          if (candidate.includes('"tool"') || candidate.includes('"name"')) {
            break // Found the tool call JSON — text before jsonStart is reasoning
          }
          jsonStart = -1 // Not a tool call, keep searching
        }
      }
    }

    if (jsonStart <= 0) return null

    // Get text before the JSON tool call
    let reasoning = content.slice(0, jsonStart).trim()
    if (!reasoning || reasoning.length < 5) return null

    // Clean up: remove markdown artifacts, excessive whitespace
    reasoning = reasoning
      .replace(/```[\s\S]*?```/g, '') // remove code blocks
      .replace(/\*\*/g, '')           // remove bold markers
      .replace(/#{1,3}\s*/g, '')      // remove heading markers
      .replace(/\n+/g, ' ')          // collapse newlines
      .trim()

    if (reasoning.length < 5) return null

    // Take first 1-2 sentences, cap at 150 chars
    const sentences = reasoning.match(/[^.!?]+[.!?]+/g)
    if (sentences && sentences.length > 0) {
      reasoning = sentences.slice(0, 2).join(' ').trim()
    }
    if (reasoning.length > 150) {
      reasoning = reasoning.slice(0, 147) + '...'
    }

    return reasoning
  }

  /**
   * Create a clean, human-readable 1-line summary for a tool result.
   * This is what the user sees in the live activity feed — NOT the raw content.
   */
  protected summarizeForUI(
    tool: string,
    args: Record<string, unknown>,
    result: { success: boolean; content: string }
  ): string {
    const toolName = tool.split('::').pop() ?? tool
    const path = args.path ? String(args.path) : ''
    const fileName = path ? path.replace(/\\/g, '/').split('/').pop() ?? path : ''

    if (!result.success) {
      // For failures, show a short reason
      const reason = result.content.slice(0, 120).split('\n')[0]
      return `Failed: ${reason}`
    }

    switch (toolName) {
      case 'file_read': {
        // Extract line info if present
        const lineMatch = result.content.match(/^\[Lines (\d+)-(\d+) of (\d+) total\]/)
        if (lineMatch) {
          return `Read ${fileName} (lines ${lineMatch[1]}-${lineMatch[2]} of ${lineMatch[3]})`
        }
        const lineCount = result.content.split('\n').length
        return `Read ${fileName} (${lineCount} lines)`
      }
      case 'file_write':
        return `Wrote ${fileName} (${this.formatBytes(args.content)})`
      case 'file_create':
        return `Created ${fileName} (${this.formatBytes(args.content)})`
      case 'file_delete':
        return `Deleted ${fileName}`
      case 'file_move':
        return `Moved ${fileName} → ${String(args.destination ?? '').replace(/\\/g, '/').split('/').pop()}`
      case 'file_edit': {
        const editMatch = result.content.match(/\((.+?),\s*(\d+)\s*bytes/)
        return editMatch
          ? `Edited ${fileName} (${editMatch[1]})`
          : `Edited ${fileName}`
      }
      case 'directory_list': {
        const entries = result.content.split('\n').filter(l => l.trim()).length
        return `Listed ${fileName || path || 'directory'} (${entries} entries)`
      }
      case 'create_directory':
        return `Created directory ${fileName || path}`
      case 'shell_execute': {
        const cmd = String(args.command ?? '').split('\n')[0]
        const shortCmd = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd
        return `Ran: ${shortCmd}`
      }
      case 'http_request': {
        const statusMatch = result.content.match(/^HTTP (\d+)\s*(.*)/)
        const url = String(args.url ?? '')
        const host = url.match(/\/\/([^/]+)/)?.[1] ?? url.slice(0, 50)
        return statusMatch
          ? `${String(args.method ?? 'GET')} ${host} → ${statusMatch[1]} ${statusMatch[2]}`
          : `HTTP request to ${host}`
      }
      case 'web_search':
        return `Searched: "${String(args.query ?? '').slice(0, 60)}"`
      case 'webpage_fetch': {
        const u = String(args.url ?? '')
        const h = u.match(/\/\/([^/]+)/)?.[1] ?? u.slice(0, 50)
        return `Fetched page: ${h}`
      }
      case 'send_notification':
        return `Sent notification: "${String(args.title ?? '')}"`
      default: {
        // MCP tools — use first 100 chars of content
        const first = result.content.slice(0, 100).split('\n')[0]
        return first.length < result.content.length ? `${first}...` : first
      }
    }
  }

  /** Format byte count from content arg for UI display */
  private formatBytes(content: unknown): string {
    if (typeof content !== 'string') return '0 bytes'
    const bytes = Buffer.byteLength(content, 'utf-8')
    if (bytes < 1024) return `${bytes} bytes`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  /** Build an AgentResult from tool execution */
  protected buildToolResult(
    status: 'success' | 'partial' | 'failed',
    output: unknown,
    confidence: number,
    tokensIn: number,
    tokensOut: number,
    model: string,
    startTime: number,
    artifacts: Artifact[],
    error?: string
  ): AgentResult {
    return {
      status,
      output,
      confidence,
      tokensIn,
      tokensOut,
      model,
      promptVersion: this.lastPromptVersion,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      error,
      duration: Date.now() - startTime,
    }
  }
}
