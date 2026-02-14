/**
 * Base Agent — Abstract class that all agents extend
 *
 * Provides the think → act → report cycle, confidence tracking,
 * LLM access, event bus integration, memory context, and optional
 * agentic tool loop (executeWithTools) that any agent can opt into.
 */
import os from 'os'
import { randomUUID } from 'crypto'
import { LLMFactory } from '../llm'
import type { LLMRequest, LLMResponse, AgentModelConfig } from '../llm'
import { getEventBus, type AgentType } from './event-bus'
import { getDatabase } from '../db/database'
import { getSoftEngine } from '../rules'
import { getPromptRegistry } from '../prompts'
import { getMcpRegistry } from '../mcp'
import { getLocalToolProvider } from '../tools'
import { getAgentPermissions, filterToolsForAgent, canAgentCallTool, hasToolAccess } from '../tools/permissions'
import type { McpTool, McpToolCallResult } from '../mcp/types'
import type { ImageAttachment } from '@shared/types'
import type { BlackboardHandle } from './blackboard'
import { canDelegate, canDelegateAtDepth, buildDelegationToolDescription } from './delegation'

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
      maxTokens: overrides?.maxTokens ?? modelConfig?.maxTokens ?? 4096,
      responseFormat: overrides?.responseFormat,
      images: context.images?.map((img) => ({ data: img.data, mimeType: img.mimeType })),
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
        0, // TODO: calculate cost from model pricing
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

    console.log(`[${this.type}] executeWithTools | taskId=${context.taskId} | model=${model} | tools=${allowedTools.length} | timeout=${Math.round(TIMEOUT_MS / 1000)}s`)
    console.log(`[${this.type}] Task: "${task.description.slice(0, 200)}"`)

    try {
      // Build context from prior subtask results
      let priorContext = ''
      if (context.siblingResults && context.siblingResults.size > 0) {
        const priorLines: string[] = []
        for (const [stepId, result] of context.siblingResults) {
          if (result.status === 'success' || result.status === 'partial') {
            const output = typeof result.output === 'string'
              ? result.output.slice(0, 500)
              : JSON.stringify(result.output).slice(0, 500)
            priorLines.push(`- ${stepId}: ${output}`)
          }
        }
        if (priorLines.length > 0) {
          priorContext = `\n\nPRIOR STEPS ALREADY COMPLETED (use this context — do NOT redo these):\n${priorLines.join('\n')}\n`
        }
      }

      const parentContext = context.parentTask
        ? `\nORIGINAL USER REQUEST: "${context.parentTask.slice(0, 300)}"\n`
        : ''

      // Inject recent conversation history so agents can resolve references like "try again"
      let historyContext = ''
      if (context.conversationHistory && context.conversationHistory.length > 0) {
        // Keep last 6 messages (3 exchanges) to stay within token budget
        const recent = context.conversationHistory.slice(-6)
        const lines = recent.map((msg) =>
          `${msg.role === 'user' ? 'User' : 'Brainwave'}: ${msg.content.slice(0, 500)}`
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
        `Do NOT respond with text. You MUST output a JSON object.`

      // ── Step 0: Forced sequential-thinking planning phase ──
      // Find the sequential_thinking MCP tool and call it automatically
      // so every agent "thinks before acting"
      let planningContext = ''
      const seqThinkTool = registry.getAllTools().find(t => t.name === 'sequential_thinking')
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
            planningContext = `\n\n== PLANNING ANALYSIS (from sequential thinking) ==\n${thinkResult.content.slice(0, 2000)}\n`
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
          `Respond with a JSON tool call to begin working on this task. ` +
          `Do NOT respond with text. You MUST output a JSON object.`
      }

      let step = 0
      let loopDetected = false
      while (step < ABSOLUTE_MAX_STEPS) {
        step++

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
                toolResults.slice(-2).map((t) => `${t.tool}: ${t.content.slice(0, 300)}`).join('\n')
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
              doneSignal.slice(0, 1500),
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
          console.warn(`[${this.type}] Step ${step}: No tool call or done signal. Raw: ${response.content.slice(0, 200)}`)
          if (corrections < MAX_CORRECTIONS) {
            corrections++
            this.bus.emitEvent('agent:acting', {
              agentType: this.type,
              taskId: context.taskId,
              action: `Sending correction ${corrections}/${MAX_CORRECTIONS}`,
            })
            currentPrompt =
              `TASK: ${task.description}\n\n` +
              (toolResults.length > 0
                ? `== TOOL HISTORY ==\n${toolResults.map((t, i) =>
                    `Step ${i + 1}: ${t.tool} → ${t.success ? 'SUCCESS' : 'FAILED'}:\n${t.content.slice(0, 800)}`
                  ).join('\n\n')}\n\n`
                : '') +
              `== ERROR: INVALID RESPONSE FORMAT ==\n` +
              `Your last response was not a valid tool call or completion signal.\n` +
              `You responded with: ${response.content.slice(0, 200)}\n\n` +
              `You MUST respond with EXACTLY one of these JSON formats:\n\n` +
              `To call a tool:\n{ "tool": "local::file_read", "args": { "path": "/some/file" } }\n\n` +
              `To signal task completion:\n{ "done": true, "summary": "your final answer here" }\n\n` +
              `Do NOT include any text outside the JSON object.`
            continue
          }

          // Too many corrections — treat response as final
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
            `TASK: ${task.description}\n\n` +
            `== TOOL HISTORY ==\n${toolResults.map((t, i) =>
              `Step ${i + 1}: ${t.tool} → ${t.success ? 'SUCCESS' : 'FAILED'}:\n${t.content.slice(0, 800)}`
            ).join('\n\n')}\n\n` +
            `== PERMISSION DENIED ==\n` +
            `You tried to call "${toolCall.tool}" but you don't have permission.\n` +
            `Reason: ${perm.reason}\n` +
            `Try a different tool that you DO have access to, or signal completion if you can answer without it.`
          continue
        }

        // ── Loop detection (multi-strategy) ──
        const argsHash = JSON.stringify(toolCall.args ?? {})
        const toolBaseName = toolCall.tool.split('::').pop() ?? toolCall.tool
        toolCallHistory.push({ tool: toolCall.tool, argsHash })

        // Update per-tool frequency
        const freq = (toolFrequency.get(toolBaseName) ?? 0) + 1
        toolFrequency.set(toolBaseName, freq)

        // Strategy 1: Exact match — same tool + identical args N times
        const callSig = `${toolCall.tool}:${argsHash}`
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
              content: `STUCK DETECTION: You have called "${toolBaseName}" ${freq} times now with different arguments but similar results. You are NOT making progress. You MUST either: (1) use a COMPLETELY DIFFERENT tool/approach, or (2) signal completion with { "done": true, "summary": "..." } summarizing what you found so far.`,
            })
            this.bus.emitEvent('agent:tool-result', {
              agentType: this.type,
              taskId: context.taskId,
              tool: toolCall.tool,
              success: false,
              summary: `Stuck warning: ${toolBaseName} called ${freq}× — agent must change approach`,
              step,
            })
            const warningHistory = toolResults.map((t, i) =>
              `Step ${i + 1}: ${t.tool} → ${t.success ? 'SUCCESS' : 'FAILED'}:\n${t.content.slice(0, 800)}`
            ).join('\n\n')
            currentPrompt =
              `TASK: ${task.description}\n\n` +
              `== TOOL HISTORY (${toolResults.length} step${toolResults.length > 1 ? 's' : ''}) ==\n${warningHistory}\n\n` +
              `== ⚠️ STUCK DETECTION ==\n` +
              `You have called "${toolBaseName}" ${freq} times. You are looping.\n` +
              `The results are NOT improving. STOP calling "${toolBaseName}".\n\n` +
              `You MUST do ONE of these:\n` +
              `1. Use a COMPLETELY DIFFERENT tool to accomplish the task\n` +
              `2. Signal completion: { "done": true, "summary": "what you found so far" }\n\n` +
              `Do NOT call "${toolBaseName}" again.`
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
              const warningHistory = toolResults.map((t, i) =>
                `Step ${i + 1}: ${t.tool} → ${t.success ? 'SUCCESS' : 'FAILED'}:\n${t.content.slice(0, 800)}`
              ).join('\n\n')
              currentPrompt =
                `TASK: ${task.description}\n\n` +
                `== TOOL HISTORY (${toolResults.length} step${toolResults.length > 1 ? 's' : ''}) ==\n${warningHistory}\n\n` +
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
                  content: outputStr.slice(0, 3000),
                })

                totalTokensIn += delegationResult.tokensIn
                totalTokensOut += delegationResult.tokensOut

                // Write delegated result to blackboard
                if (context.blackboard && (delegationResult.status === 'success' || delegationResult.status === 'partial')) {
                  context.blackboard.board.write(
                    context.blackboard.planId,
                    `delegated-${targetAgent}-result`,
                    outputStr.slice(0, 1500),
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
                    output: outputStr.slice(0, 2000),
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
          this.bus.emitEvent('agent:tool-result', {
            agentType: this.type,
            taskId: context.taskId,
            tool: delegEventResult.tool,
            success: delegEventResult.success,
            summary: delegEventResult.content.slice(0, 500),
            step,
          })

          // Build context for next iteration after delegation
          const delegHistoryLines = toolResults.map((t, i) =>
            `Step ${i + 1}: ${t.tool} → ${t.success ? 'SUCCESS' : 'FAILED'}:\n${t.content.length > 1500 ? t.content.slice(0, 1500) + '\n...(truncated)' : t.content}`
          ).join('\n\n')

          let delegBlackboard = ''
          if (context.blackboard) {
            delegBlackboard = context.blackboard.board.formatForPrompt(
              context.blackboard.planId, this.type, context.taskId
            )
          }

          const lastDelegResult = toolResults[toolResults.length - 1]
          currentPrompt =
            `TASK: ${task.description}\n\n` +
            `== TOOL HISTORY (${toolResults.length} step${toolResults.length > 1 ? 's' : ''}) ==\n${delegHistoryLines}\n\n` +
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

        this.bus.emitEvent('agent:acting', {
          agentType: this.type,
          taskId: context.taskId,
          action: `Calling tool: ${toolCall.tool}${step > 1 ? ` (step ${step})` : ''}`,
        })

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
            result.content.slice(0, 1500),
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
          summary: result.content.slice(0, 500),
          step,
        })

        // Build context for next iteration
        const historyLines = toolResults.map((t, i) =>
          `Step ${i + 1}: ${t.tool} → ${t.success ? 'SUCCESS' : 'FAILED'}:\n${t.content.length > 1500 ? t.content.slice(0, 1500) + '\n...(truncated)' : t.content}`
        ).join('\n\n')

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
          `TASK: ${task.description}\n\n` +
          `== TOOL HISTORY (${toolResults.length} step${toolResults.length > 1 ? 's' : ''}) ==\n${historyLines}\n\n` +
          (latestBlackboard ? `== SHARED CONTEXT FROM OTHER AGENTS ==${latestBlackboard}\n\n` : '') +
          `== INSTRUCTIONS ==\n` +
          `Continue working until the task is complete.\n` +
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
      const summaryPrompt =
        `Original task: ${task.description}\n\n` +
        `${stopReason} Here's what happened across ${toolResults.length} steps (showing last 10):\n` +
        toolResults.slice(-10).map((t) =>
          `${t.tool} → ${t.success ? 'SUCCESS' : 'FAILED'}: ${t.content.slice(0, 300)}`
        ).join('\n') +
        `\n\nIMPORTANT: You have NO more tool calls. Do NOT output any JSON or tool calls.\n` +
        `Write a plain-text summary for the user:\n` +
        `1. What was accomplished\n` +
        `2. What remains incomplete\n` +
        `3. Suggest next steps if relevant\n\n` +
        `Respond ONLY with plain text. No JSON. No tool calls.`

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
      const extracted = this.extractFirstJsonObject(chunk)
      if (extracted) {
        try {
          const result = extractTool(JSON.parse(extracted))
          if (result) {
            if (chunks.length > 1) {
              console.log(`[${this.type}] Extracted first tool call from ${chunks.length} [TOOL_CALL] chunks`)
            }
            return result
          }
        } catch { /* keep trying next chunk */ }
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
   * Extract the first balanced JSON object from a string that may contain
   * surrounding prose. Uses bracket counting to find the matching '}'.
   */
  protected extractFirstJsonObject(text: string): string | null {
    const start = text.indexOf('{')
    if (start === -1) return null

    let depth = 0
    let inString = false
    let escape = false
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
          return text.slice(start, i + 1)
        }
      }
    }
    return null // unbalanced
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
