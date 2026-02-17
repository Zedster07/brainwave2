/**
 * Base Agent — Abstract class that all agents extend
 *
 * Provides the think → act → report cycle, confidence tracking,
 * LLM access, event bus integration, memory context, and optional
 * agentic tool loop (executeWithTools) that any agent can opt into.
 *
 * Uses XML tool protocol: the LLM embeds tool calls as XML blocks
 * in its natural-language response, and signals completion with
 * <attempt_completion>. Multi-turn conversation history is maintained
 * via ConversationManager.
 */
import os from 'os'
import { randomUUID } from 'crypto'
import { readFile as fsReadFile } from 'fs/promises'
import { LLMFactory } from '../llm'
import type { LLMRequest, LLMResponse, AgentModelConfig, ConversationMessage } from '../llm'
import type {
  ContentBlock,
  StructuredMessage,
  ToolUseBlock,
  ToolResultBlock,
  StreamEvent,
  NativeToolDefinition,
} from '../llm/types'
import {
  getModelCapabilities,
  extractTextFromBlocks,
  extractToolUseBlocks,
  createToolResult,
  textToBlocks,
} from '../llm/types'
import {
  toAnthropicTools,
  ToolNameMap,
  buildCompletionToolDefinition,
  buildDelegationToolDefinition as buildNativeDelegationTool,
  buildParallelDelegationToolDefinition as buildNativeParallelDelegationTool,
} from '../llm/tool-definitions'
import { getEventBus, type AgentType } from './event-bus'
import { getDatabase } from '../db/database'
import { getSoftEngine } from '../rules'
import { getPromptRegistry } from '../prompts'
import { calculateBudget, formatTokenCount, countTokens, MAX_INPUT_BUDGET, REASONING_RESERVE_TOKENS, PROACTIVE_COMPACTION_THRESHOLD } from '../llm/token-counter'
import { type FileRegistryEntry, compactContext, buildCompactionNotice } from './context-compactor'
import { FileContextTracker } from './file-context-tracker'
import { calculateCost, formatCost } from '../llm/pricing'
import { getMcpRegistry } from '../mcp'
import { getLocalToolProvider } from '../tools'
import { getAgentPermissions, filterToolsForAgent, filterToolsForMode, canAgentCallTool, hasToolAccess } from '../tools/permissions'
import { getModeRegistry, type ModeConfig } from '../modes'
import type { McpTool, McpToolCallResult } from '../mcp/types'
import type { ImageAttachment } from '@shared/types'
import type { BlackboardHandle } from './blackboard'
import { canDelegate, canDelegateAtDepth, buildDelegationToolDescription, buildParallelDelegationToolDescription, type DelegationContext } from './delegation'
import { type CancellationToken, CancellationError } from './cancellation'
import { requiresApproval, requestApproval, classifyToolSafety, type ApprovalSettings, getDefaultApprovalSettings } from '../tools/approval'
import { parseAssistantMessage, xmlToolToLocalCall, registerToolName } from './xml-parser'
import { StreamingXmlParser, type StreamingFeedResult } from './streaming-xml-parser'
import { extractToolsFromProse } from './prose-tool-extractor'
import { ConversationManager, formatToolResult, formatSystemNotice } from './conversation-manager'
import { getCheckpointService, type CheckpointEntry } from './checkpoint-service'
import { detectWorkspace, getEnvironmentDetails, getCompactEnvironmentDetails, buildSystemEnvironmentBlock } from './environment'
import { getInstructionManager } from '../instructions'
import {
  ToolRepetitionDetector,
  createMistakeCounters,
  recordFileError,
  buildDiffFallbackMessage,
  GRACE_RETRY_THRESHOLD,
  MAX_GENERAL_MISTAKES,
  type MistakeCounters,
} from './tool-repetition-detector'

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
  /** Injected by AgentPool — allows agents to spawn multiple sub-agents in parallel */
  parallelDelegateFn?: (tasks: Array<{ agent: AgentType; task: string }>) => Promise<AgentResult[]>
  /** Current delegation depth (0 = top-level, incremented per delegation) */
  delegationDepth?: number
  /** Context from parent agent (Boomerang pattern) */
  delegationContext?: DelegationContext
  /** Tooling needs from triage — tells agents what capabilities to use */
  toolingNeeds?: ToolingNeeds
  /** Cancellation token — checked every iteration to support user abort */
  cancellationToken?: CancellationToken
  /** Resolved working directory for this task (defaults to detectWorkspace() result) */
  workDir?: string
  /** Active mode slug — when set, tool filtering uses mode-based rules instead of agent defaults */
  mode?: string
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
   * Get approval settings — loaded from SQLite settings or defaults.
   * The user configures this in Settings → Approval tab.
   */
  protected getApprovalSettings(): ApprovalSettings {
    try {
      const db = getDatabase()
      const row = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'approval_settings')
      if (row?.value) {
        return { ...getDefaultApprovalSettings(), ...JSON.parse(row.value) }
      }
    } catch {
      // Fall through to defaults
    }
    return getDefaultApprovalSettings()
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
   * Think with multi-turn conversation history.
   *
   * Instead of a single user prompt, sends the full conversation array
   * (managed by ConversationManager) via the `messages` field in LLMRequest.
   * The system prompt and memory context are still set normally.
   *
   * This is the primary method used by the agentic tool loop (executeWithTools).
   * The LLM sees the entire conversation history and responds naturally with
   * prose + XML tool blocks.
   */
  protected async thinkWithHistory(
    messages: ConversationMessage[],
    context: AgentContext,
    overrides?: { temperature?: number; maxTokens?: number },
    /** Pre-loaded custom instruction block (Phase 12) — injected between system prompt and constraints */
    instructionBlock?: string
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
      system: systemPrompt + (instructionBlock ?? '') + constraintBlock,
      user: '', // ignored when messages is set
      messages,
      context: memoryContext || undefined,
      temperature: overrides?.temperature ?? modelConfig?.temperature ?? 0.7,
      maxTokens: overrides?.maxTokens ?? modelConfig?.maxTokens,
      // No responseFormat — let the model respond naturally (prose + XML tool blocks)
      signal: context.cancellationToken?.signal,
    }

    const msgCount = messages.length
    const lastMsg = messages[msgCount - 1]
    const lastPreview = lastMsg ? `${lastMsg.role}: ${lastMsg.content.slice(0, 100)}...` : '(empty)'
    console.log(`[${this.type}] thinkWithHistory() → model=${request.model} | msgs=${msgCount} | last=${lastPreview}`)

    const response = await adapter.complete(request)

    console.log(`[${this.type}] thinkWithHistory() ← ${response.tokensIn}+${response.tokensOut} tokens | finish=${response.finishReason} | response=${response.content.slice(0, 200)}...`)

    return response
  }

  /**
   * Stream with multi-turn conversation history.
   *
   * Like thinkWithHistory() but uses `adapter.stream()` instead of `complete()`.
   * Yields tokens as they arrive while accumulating the full response.
   * Returns an LLMResponse-compatible object at the end with the full content
   * and estimated token counts.
   *
   * The caller (executeWithTools) uses this to:
   * 1. Feed chunks through StreamingXmlParser for live tool detection
   * 2. Emit `agent:stream-chunk` events so the frontend can render live text
   * 3. Get the final full response for conversation history
   */
  protected async streamWithHistory(
    messages: ConversationMessage[],
    context: AgentContext,
    overrides?: { temperature?: number; maxTokens?: number },
    onChunk?: (chunk: string, accumulated: string) => void,
    /** Pre-loaded custom instruction block (Phase 12) — injected between system prompt and constraints */
    instructionBlock?: string
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
      system: systemPrompt + (instructionBlock ?? '') + constraintBlock,
      user: '', // ignored when messages is set
      messages,
      context: memoryContext || undefined,
      temperature: overrides?.temperature ?? modelConfig?.temperature ?? 0.7,
      maxTokens: overrides?.maxTokens ?? modelConfig?.maxTokens,
      signal: context.cancellationToken?.signal,
    }

    const msgCount = messages.length
    const lastMsg = messages[msgCount - 1]
    const lastPreview = lastMsg ? `${lastMsg.role}: ${lastMsg.content.slice(0, 100)}...` : '(empty)'
    console.log(`[${this.type}] streamWithHistory() → model=${request.model} | msgs=${msgCount} | last=${lastPreview}`)

    let accumulated = ''
    let isFirst = true

    // Retry with exponential backoff on transient stream failures
    const MAX_STREAM_RETRIES = 3
    for (let streamAttempt = 0; streamAttempt <= MAX_STREAM_RETRIES; streamAttempt++) {
      try {
        for await (const chunk of adapter.stream(request)) {
          accumulated += chunk
          if (onChunk) onChunk(chunk, accumulated)

          // Emit stream chunk event for the IPC → renderer pipeline
          this.bus.emitEvent('agent:stream-chunk', {
            taskId: context.taskId,
            agentType: this.type,
            chunk,
            isFirst,
          })
          isFirst = false
        }
        break // success — exit retry loop
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
        const isRetryable = ['rate_limit', 'rate limit', '429', 'timeout', 'etimedout', 'econnreset',
          'econnrefused', 'socket hang up', '502', '503', '504', 'overloaded', 'capacity'].some(p => errMsg.includes(p))

        if (accumulated.length > 0) {
          // Got partial content — use it rather than retrying
          console.warn(`[${this.type}] streamWithHistory() stream error after ${accumulated.length} chars, using partial content:`, err)
          break
        } else if (isRetryable && streamAttempt < MAX_STREAM_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, streamAttempt), 30000)
          console.warn(`[${this.type}] streamWithHistory() retryable error (attempt ${streamAttempt + 1}/${MAX_STREAM_RETRIES}), retrying in ${delay}ms:`, err)
          await new Promise(resolve => setTimeout(resolve, delay))
          isFirst = true
          continue
        } else {
          throw err
        }
      }
    }

    // Emit stream end event
    this.bus.emitEvent('agent:stream-end', {
      taskId: context.taskId,
      agentType: this.type,
      fullText: accumulated,
    })

    // Estimate token counts post-hoc (stream doesn't return usage metadata)
    const systemTokens = countTokens(request.system + (request.context ?? ''))
    const messagesTokens = messages.reduce((sum, m) => sum + countTokens(m.content), 0)
    const outputTokens = countTokens(accumulated)

    const response: LLMResponse = {
      content: accumulated,
      model: request.model ?? modelConfig?.model ?? 'unknown',
      tokensIn: systemTokens + messagesTokens,
      tokensOut: outputTokens,
      finishReason: 'stop',
    }

    console.log(`[${this.type}] streamWithHistory() ← ~${response.tokensIn}+${response.tokensOut} tokens (estimated) | streamed ${accumulated.length} chars`)

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
  protected buildToolSection(mode?: string): string {
    if (!hasToolAccess(this.type)) return ''

    const registry = getMcpRegistry()
    const localProvider = getLocalToolProvider()
    const allTools = [...localProvider.getTools(), ...registry.getAllTools()]

    // When a mode is active, use mode-based filtering; otherwise fall back to agent type filtering
    const modeConfig = mode ? getModeRegistry().get(mode) : undefined
    const allowed = modeConfig
      ? filterToolsForMode(modeConfig, allTools)
      : filterToolsForAgent(this.type, allTools)

    if (allowed.length === 0) return ''

    // Register MCP tool names with the XML parser for runtime recognition
    for (const t of allowed) {
      const shortName = t.key.split('::').pop()
      if (shortName) registerToolName(shortName)
    }

    const lines = allowed.map((t) => {
      const schema = t.inputSchema as { properties?: Record<string, unknown> }
      const params = Object.keys(schema.properties ?? {}).join(', ')
      return `- ${t.key}: ${t.description}${params ? ` (params: ${params})` : ''}`
    })

    const permConfig = getAgentPermissions(this.type)
    const maxSteps = permConfig.maxSteps ?? 5

    // Include delegation tools if this agent can delegate
    const delegationDesc = buildDelegationToolDescription(this.type)
    const parallelDesc = buildParallelDelegationToolDescription(this.type)
    let delegationSection = ''
    if (delegationDesc || parallelDesc) {
      delegationSection = '\n\n## Agent Delegation\nYou can delegate sub-tasks to specialist agents:\n'
      if (delegationDesc) {
        delegationSection += `${delegationDesc}\n\nCall it like any other tool:\n<delegate_to_agent>\n<agent>agent_type</agent>\n<task>description of the sub-task</task>\n</delegate_to_agent>\n`
      }
      if (parallelDesc) {
        delegationSection += `\n${parallelDesc}\n\nFor parallel tasks, provide a JSON array:\n<use_subagents>\n<tasks>\n[\n  { "agent": "researcher", "task": "Research OAuth2 best practices" },\n  { "agent": "coder", "task": "Implement the login component" }\n]\n</tasks>\n</use_subagents>\n\nUse use_subagents when tasks are independent and can run concurrently.\nUse delegate_to_agent when you need one result before proceeding.`
      }
    }

    return `

## Available Tools
${lines.join('\n')}

## Tool Call Protocol
To call a tool, include an XML tool block in your response:

<tool_name>
<param1>value1</param1>
<param2>value2</param2>
</tool_name>

### Examples

Reading a file:
<read_file>
<path>/absolute/path/to/file.ts</path>
</read_file>

Writing a file:
<write_to_file>
<path>/absolute/path/to/file.ts</path>
<content>
file content here
</content>
</write_to_file>

Editing a file (search and replace):
<replace_in_file>
<path>/absolute/path/to/file.ts</path>
<diff>
<<<<<<< SEARCH
old code to find
=======
new code to replace with
>>>>>>> REPLACE
</diff>
</replace_in_file>

Running a command:
<execute_command>
<command>npm run build</command>
</execute_command>

### Rules
- tool_key format is "serverId::toolName" — use the EXACT key from the tool list above
- You can include ONE tool call per response for write/execute operations
- You MAY include MULTIPLE read-only tool calls (file_read, directory_list, search_files) in a single response — they run in parallel
- You MAY include reasoning/explanation text before the tool block
- After seeing the tool result, decide: call another tool OR signal completion
- ${maxSteps} tool calls is a soft limit. For complex tasks you may use more, but aim for efficiency
- For file paths, always use absolute paths
${delegationSection}

## Completion Signal
When the task is FULLY complete, signal completion:

<attempt_completion>
<result>
Your final answer / summary here
</result>
</attempt_completion>

Do NOT use \`{ "done": true }\` — always use the XML completion block above.`
  }

  // ═════════════════════════════════════════════════════════════
  // ══ NATIVE TOOL CALLING LOOP (M2.5 / Anthropic SDK) ════════
  // ═════════════════════════════════════════════════════════════

  /**
   * Execute a task using NATIVE tool calling (Anthropic SDK format).
   *
   * This is the M2.5-optimized alternative to executeWithTools (XML protocol).
   * Automatically selected when the agent's model supports native tools.
   *
   * KEY DIFFERENCES from XML protocol:
   * 1. Tools are passed via the API's `tools` parameter (not text in system prompt)
   * 2. Model responds with structured content blocks (thinking + text + tool_use)
   * 3. Tool results are sent as proper tool_result blocks (not XML-in-user-message)
   * 4. Full response (including thinking blocks) is preserved in history
   * 5. No XML parsing needed — tool calls come as structured data
   *
   * M2.5 CARDINAL RULES:
   * - temperature MUST be 1.0 when thinking is enabled
   * - Full response content (including thinking) MUST be preserved in history
   * - thinking blocks MUST NOT be modified or summarized
   * - System prompt goes in top-level `system` param, NOT in messages
   */
  protected async executeWithNativeTools(
    task: SubTask,
    context: AgentContext,
  ): Promise<AgentResult> {
    const startTime = Date.now()
    const modelConfig = LLMFactory.getAgentConfig(this.type)
    const permConfig = getAgentPermissions(this.type)
    const registry = getMcpRegistry()
    const localProvider = getLocalToolProvider()
    const model = modelConfig?.model ?? 'minimax/minimax-m2.5'
    const capabilities = getModelCapabilities(model)

    // Get allowed tools for this agent
    const allTools = [...localProvider.getTools(), ...registry.getAllTools()]
    const modeConfig = context.mode ? getModeRegistry().get(context.mode) : undefined
    const allowedTools = modeConfig
      ? filterToolsForMode(modeConfig, allTools)
      : filterToolsForAgent(this.type, allTools)

    // Convert to native tool definitions
    const nativeTools = toAnthropicTools(allowedTools)
    const toolNameMap = new ToolNameMap(allowedTools)

    // Add completion signal tool
    nativeTools.push(buildCompletionToolDefinition())

    // Add delegation tools if applicable
    // (delegation tool definitions would be added here if agent can delegate)

    // Native tool calling REQUIRES the Anthropic adapter — it handles structured
    // content blocks (thinking, text, tool_use, tool_result), the tools API param,
    // and interleaved thinking. OpenRouterProvider.complete() silently drops them.
    // The Anthropic adapter auto-configures to go through OpenRouter's URL when
    // only an OpenRouter key is available, so routing stays the same.
    const provider = LLMFactory.getProvider('anthropic')

    this.bus.emitEvent('agent:thinking', {
      agentType: this.type,
      taskId: context.taskId,
      model,
    })

    let totalTokensIn = 0
    let totalTokensOut = 0
    const artifacts: Artifact[] = []
    const toolResults: Array<{ tool: string; success: boolean; content: string }> = []

    // Safety constants
    const TIMEOUT_MS = permConfig.timeoutMs ?? 5 * 60 * 1000
    const ABSOLUTE_MAX_STEPS = 100
    const MAX_CONSECUTIVE_ERRORS = 5
    let consecutiveErrors = 0

    // File context tracking
    const fileRegistry = new Map<string, FileRegistryEntry>()
    const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase()
    const fileTracker = new FileContextTracker()

    // Workspace detection
    const workDir = context.workDir
      ?? detectWorkspace(task.description, context.parentTask, this.getBrainwaveHomeDir())

    // .brainwaveignore
    const instructionMgr = getInstructionManager()
    const ignoreMatcher = await instructionMgr.getIgnoreMatcher(workDir)
    const customInstructionBlock = await instructionMgr.buildBlock({
      workDir,
      mode: context.mode,
    })

    // Initialize conversation manager in native mode
    // Cap input budget at MAX_INPUT_BUDGET even for models with huge context windows
    // (sending 1M tokens is slow, expensive, and degrades quality).
    // Reserve extra tokens for thinking if the model supports extended thinking.
    const rawContextLimit = calculateBudget(model, 0).contextLimit
    const cappedBudget = Math.min(rawContextLimit, MAX_INPUT_BUDGET)
    const responseReserve = capabilities.supportsThinking
      ? 8_000 + REASONING_RESERVE_TOKENS // 24K total: 8K response + 16K thinking headroom
      : 8_000
    const conversation = new ConversationManager(cappedBudget, responseReserve)
    conversation.enableNativeMode()

    console.log(
      `[${this.type}] executeWithNativeTools | taskId=${context.taskId} | model=${model} | ` +
      `tools=${nativeTools.length} | timeout=${Math.round(TIMEOUT_MS / 1000)}s | native=true | ` +
      `budget=${cappedBudget} (raw=${rawContextLimit}) | responseReserve=${responseReserve}`
    )

    try {
      // ── Build system prompt (strip XML tool catalog — tools go via API param) ──
      const rawSystemPrompt = await this.getSystemPrompt(context)
      // Remove the XML tool catalog + protocol section injected by buildToolSection().
      // Native tool calling provides tools via the API `tools` param — having an XML
      // catalog in the system prompt confuses the model into mangling tool names
      // (e.g. prepending "bundled::" or mixing XML/native call formats).
      const systemPrompt = rawSystemPrompt.replace(/\n+## Available Tools[\s\S]*$/, '')
      const systemWithInstructions = customInstructionBlock
        ? `${systemPrompt}\n\n${customInstructionBlock}`
        : systemPrompt

      // ── Build initial user message ──
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
          priorContext = `\n\nPRIOR STEPS ALREADY COMPLETED:\n${priorLines.join('\n')}\n`
        }
      }

      const parentContext = context.parentTask
        ? `\nORIGINAL USER REQUEST: "${context.parentTask}"\n`
        : ''

      let historyContext = ''
      if (context.conversationHistory && context.conversationHistory.length > 0) {
        const recent = context.conversationHistory.slice(-6)
        const lines = recent.map(msg =>
          `${msg.role === 'user' ? 'User' : 'Brainwave'}: ${msg.content}`
        ).join('\n')
        historyContext = `\n\nRECENT CONVERSATION:\n${lines}\n`
      }

      const envDetails = await getEnvironmentDetails({
        workDir,
        brainwaveHomeDir: this.getBrainwaveHomeDir(),
        contextLimitTokens: cappedBudget,
        fileTracker,
        includeTree: true,
        treeMaxDepth: 3,
        treeMaxEntries: 200,
      })

      const initialMessage =
        `TASK: ${task.description}\n${parentContext}${historyContext}${priorContext}\n${envDetails}\n` +
        `Begin working on this task. Use the provided tools to take actions.\n` +
        `When done, call the attempt_completion tool with your final result.`

      // Add as structured user message
      conversation.addStructuredUserMessage(initialMessage)

      let step = 0

      while (step < ABSOLUTE_MAX_STEPS) {
        step++

        // ── Cancellation check ──
        if (context.cancellationToken?.isCancelled) {
          console.log(`[${this.type}] Cancelled at step ${step}`)
          const anySuccess = toolResults.some(t => t.success)
          return this.buildToolResult(
            anySuccess ? 'partial' : 'failed',
            anySuccess ? 'Task cancelled. Partial results available.' : 'Task cancelled by user.',
            anySuccess ? 0.4 : 0.1,
            totalTokensIn, totalTokensOut, model, startTime, artifacts,
          )
        }

        // ── Timeout check ──
        if (Date.now() - startTime > TIMEOUT_MS) {
          const anySuccess = toolResults.some(t => t.success)
          return this.buildToolResult(
            anySuccess ? 'partial' : 'failed',
            `Timed out after ${Math.round((Date.now() - startTime) / 1000)}s.`,
            anySuccess ? 0.5 : 0.2,
            totalTokensIn, totalTokensOut, model, startTime, artifacts,
          )
        }

        this.bus.emitEvent('agent:acting', {
          agentType: this.type,
          taskId: context.taskId,
          action: `Step ${step}: ${step === 1 ? 'Analyzing task...' : 'Processing...'}`,
        })

        // ── Token budget check — proactive compaction at 60% ──
        if (step > 1 && conversation.isStructuredNearBudget(PROACTIVE_COMPACTION_THRESHOLD)) {
          const ratio = conversation.getStructuredUsageRatio()
          console.log(
            `[${this.type}] Step ${step}: Context at ${Math.round(ratio * 100)}% — proactive compaction`
          )
          conversation.proactiveCompact(0.55)
        }

        // ── Call LLM with native tools ──
        const structuredMessages = conversation.getStructuredMessages()

        // ── Prompt Caching: mark system prompt & last tool for caching ──
        // Anthropic caches everything up to and including the cache_control marker.
        // System prompt + tool defs are static across the loop — perfect cache candidates.
        const systemBlocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [
          { type: 'text', text: systemWithInstructions, cache_control: { type: 'ephemeral' } },
        ]

        // Mark the last tool for caching (tools are static across iterations)
        const cachedTools = nativeTools.map((t, i) =>
          i === nativeTools.length - 1
            ? { ...t, cache_control: { type: 'ephemeral' as const } }
            : t
        )

        const response = await provider.complete({
          model,
          system: systemWithInstructions,
          systemBlocks,
          user: '', // Not used when structuredMessages is set
          structuredMessages,
          tools: cachedTools,
          temperature: capabilities.supportsThinking ? 1.0 : (modelConfig?.temperature ?? 0.7),
          maxTokens: modelConfig?.maxTokens ?? 8192,
          signal: context.cancellationToken?.signal,
        })

        totalTokensIn += response.tokensIn
        totalTokensOut += response.tokensOut

        // ── Log cache metrics if available ──
        if (response.cacheMetrics) {
          const { cacheCreationInputTokens, cacheReadInputTokens } = response.cacheMetrics
          if (cacheCreationInputTokens > 0 || cacheReadInputTokens > 0) {
            console.log(
              `[${this.type}] Step ${step} cache: ` +
              `created=${cacheCreationInputTokens} read=${cacheReadInputTokens} ` +
              `(${cacheReadInputTokens > 0 ? 'HIT' : 'MISS'})`
            )
          }
        }

        // ── Preserve FULL response in history (M2.5 cardinal rule) ──
        const contentBlocks = response.contentBlocks ?? textToBlocks(response.content)
        conversation.addStructuredMessage('assistant', contentBlocks)

        // ── Extract text content first (needed for isFirst checks) ──
        const textContent = extractTextFromBlocks(contentBlocks)

        // ── Emit thinking for UI ──
        const thinkingBlocks = contentBlocks.filter(b => b.type === 'thinking')
        if (thinkingBlocks.length > 0) {
          for (const tb of thinkingBlocks) {
            if (tb.type === 'thinking' && tb.thinking.length > 0) {
              // Emit full thinking as 💭-prefixed stream chunk for ThinkingBlock rendering
              this.bus.emitEvent('agent:stream-chunk', {
                agentType: this.type,
                taskId: context.taskId,
                chunk: `💭 ${tb.thinking}`,
                isFirst: step === 1 && !textContent,
              })
            }
          }
        }

        // ── Emit text for UI streaming ──
        if (textContent) {
          // Emit as stream chunk for live UI updates
          this.bus.emitEvent('agent:stream-chunk', {
            agentType: this.type,
            taskId: context.taskId,
            chunk: textContent,
            isFirst: step === 1,
          })
        }

        // ── Extract tool_use blocks ──
        const toolUseBlocks = extractToolUseBlocks(contentBlocks)

        // ── No tool calls — check if this is a final text response ──
        if (toolUseBlocks.length === 0) {
          if (response.finishReason === 'end_turn' || response.finishReason === 'stop') {
            // Model chose to stop without tools — treat as completion
            console.log(`[${this.type}] Step ${step}: Model stopped without tools — treating as completion`)
            const anySuccess = toolResults.some(t => t.success)
            return this.buildToolResult(
              anySuccess ? 'success' : 'partial',
              textContent || 'Task completed.',
              anySuccess ? 0.8 : 0.6,
              totalTokensIn, totalTokensOut, model, startTime, artifacts,
            )
          }

          // Nudge the model to use tools or complete
          conversation.addStructuredNotice(
            'Your response did not include any tool calls. ' +
            'Use the available tools to take action, or call attempt_completion to finish.'
          )
          consecutiveErrors++
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            return this.buildToolResult(
              'failed',
              textContent || 'Model failed to use tools.',
              0.2,
              totalTokensIn, totalTokensOut, model, startTime, artifacts,
            )
          }
          continue
        }

        consecutiveErrors = 0

        // ── Process tool calls ──
        const resultBlocks: ContentBlock[] = []

        for (const toolUse of toolUseBlocks) {
          // Check for completion signal
          if (toolUse.name === 'attempt_completion') {
            const completionResult = (toolUse.input as { result?: string }).result ?? textContent
            console.log(`[${this.type}] Completion at step ${step}: "${completionResult?.slice(0, 200)}..."`)
            const anySuccess = toolResults.some(t => t.success)

            this.bus.emitEvent('agent:completed', {
              agentType: this.type,
              taskId: context.taskId,
              confidence: anySuccess ? 0.9 : 0.7,
              tokensIn: totalTokensIn,
              tokensOut: totalTokensOut,
              toolsCalled: toolResults.map(t => t.tool),
            })

            return this.buildToolResult(
              anySuccess ? 'success' : 'partial',
              completionResult ?? 'Task completed.',
              anySuccess ? 0.9 : 0.7,
              totalTokensIn, totalTokensOut, model, startTime, artifacts,
            )
          }

          // Map API name back to internal tool key
          const internalKey = toolNameMap.toInternalKey(toolUse.name)

          // Permission check
          const perm = canAgentCallTool(this.type, internalKey)
          if (!perm.allowed) {
            console.warn(`[${this.type}] BLOCKED: ${internalKey} — ${perm.reason}`)
            toolResults.push({ tool: internalKey, success: false, content: `PERMISSION DENIED: ${perm.reason}` })
            resultBlocks.push(createToolResult(toolUse.id, `PERMISSION DENIED: ${perm.reason}`, true))
            continue
          }

          // .brainwaveignore check
          if (ignoreMatcher.hasPatterns) {
            const targetPath = (toolUse.input as Record<string, unknown>).path as string | undefined
            if (targetPath && ignoreMatcher.isIgnored(targetPath)) {
              const msg = `ACCESS BLOCKED: "${targetPath}" is excluded by .brainwaveignore.`
              toolResults.push({ tool: internalKey, success: false, content: msg })
              resultBlocks.push(createToolResult(toolUse.id, msg, true))
              continue
            }
          }

          // Approval gate
          const approvalSettings = this.getApprovalSettings()
          const mcpAutoApproved = registry.isToolAutoApproved(internalKey)
          if (requiresApproval(internalKey, approvalSettings, mcpAutoApproved)) {
            const approval = await requestApproval(
              context.taskId,
              this.type,
              internalKey,
              toolUse.input,
            )
            if (!approval.approved) {
              const rejectMsg = `Rejected by user.${approval.reason ? ` Reason: ${approval.reason}` : ''}`
              toolResults.push({ tool: internalKey, success: false, content: rejectMsg })
              resultBlocks.push(createToolResult(toolUse.id, rejectMsg, true))
              continue
            }
          }

          // Execute the tool
          console.log(`[${this.type}] Step ${step}: ${internalKey} args=${JSON.stringify(toolUse.input).slice(0, 200)}`)
          const toolStartTime = Date.now()

          const toolBaseName = internalKey.split('::').pop() ?? internalKey
          const result = internalKey.startsWith('local::')
            ? await localProvider.callTool(toolBaseName, toolUse.input, { taskId: context.taskId })
            : await registry.callTool(internalKey, toolUse.input)

          const toolDuration = Date.now() - toolStartTime
          console.log(`[${this.type}] Step ${step}: ${internalKey} → ${result.success ? 'OK' : 'FAIL'} (${toolDuration}ms)`)

          toolResults.push({
            tool: internalKey,
            success: result.success,
            content: result.content,
          })

          // Build tool_result block
          resultBlocks.push(createToolResult(toolUse.id, result.content, !result.success))

          // Emit tool result for UI
          const summary = this.summarizeForUI(internalKey, toolUse.input, result)
          this.bus.emitEvent('agent:tool-result', {
            agentType: this.type,
            taskId: context.taskId,
            tool: internalKey,
            success: result.success,
            summary,
            step,
          })
          this.emitToolCallInfo({
            taskId: context.taskId,
            step,
            tool: internalKey,
            args: toolUse.input,
            success: result.success,
            summary,
            duration: toolDuration,
            resultPreview: result.content.slice(0, 300),
          })

          // File registry tracking
          const isReadOp = ['file_read', 'directory_list', 'read_file'].includes(toolBaseName)
          const readPath = (toolUse.input as Record<string, unknown>).path as string | undefined
          if (result.success && isReadOp && readPath) {
            fileRegistry.set(normPath(readPath), { content: result.content, step })
            fileTracker.trackFileRead(readPath, step)
          }
          const isWriteOp = ['file_edit', 'file_write', 'file_create'].includes(toolBaseName)
          if (result.success && isWriteOp && readPath) {
            fileTracker.trackFileEdit(readPath, step)
          }

          // Artifact tracking
          artifacts.push({
            type: 'json',
            name: `tool-${toolBaseName}-step${step}`,
            content: JSON.stringify(result, null, 2),
          })
        }

        // ── Add all tool results as a single user message ──
        if (resultBlocks.length > 0) {
          conversation.addNativeToolResults(resultBlocks as ToolResultBlock[])
        }

        // ── Context usage reporting (every 5 steps) ──
        if (step % 5 === 0) {
          const ctxSummary = conversation.getContextSummary()
          console.log(
            `[${this.type}] Step ${step}: Context ${ctxSummary.usagePercent}% ` +
            `(${formatTokenCount(ctxSummary.tokensUsed)} / ${formatTokenCount(ctxSummary.budgetTotal)})`
          )
        }
      }

      // Safety valve — max steps reached
      const anySuccess = toolResults.some(t => t.success)
      return this.buildToolResult(
        anySuccess ? 'partial' : 'failed',
        `Safety limit reached (${ABSOLUTE_MAX_STEPS} steps).`,
        anySuccess ? 0.5 : 0.2,
        totalTokensIn, totalTokensOut, model, startTime, artifacts,
      )
    } catch (err) {
      if (CancellationError.is(err) || (err instanceof Error && err.name === 'AbortError')) {
        const anySuccess = toolResults.some(t => t.success)
        return this.buildToolResult(
          anySuccess ? 'partial' : 'failed',
          anySuccess ? 'Task cancelled. Partial results available.' : 'Task cancelled.',
          anySuccess ? 0.4 : 0.1,
          totalTokensIn, totalTokensOut, model, startTime, artifacts,
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
        totalTokensIn, totalTokensOut, model, startTime, artifacts, error,
      )
    }
  }

  /**
   * Execute a task using the agentic tool loop (XML protocol + multi-turn conversation).
   *
   * Architecture:
   * 1. Build initial task prompt as first user message
   * 2. Send conversation history via thinkWithHistory()
   * 3. Parse assistant response with XML parser (tool blocks + prose + completion)
   * 4. Execute tool calls, add results as user messages
   * 5. Repeat until <attempt_completion> or limits reached
   *
   * The LLM responds naturally with prose reasoning + XML tool blocks.
   * No anti-narration or JSON format enforcement is needed.
   * Tool access is gated by the permission system.
   *
   * If no tools are available (tier=none or no tools discovered), falls back
   * to a single think() call and returns the text result.
   */
  protected async executeWithTools(
    task: SubTask,
    context: AgentContext
  ): Promise<AgentResult> {
    // ── Route to native tool calling if model supports it ──
    const nativeModelConfig = LLMFactory.getAgentConfig(this.type)
    if (nativeModelConfig?.useNativeTools) {
      const caps = getModelCapabilities(nativeModelConfig.model ?? '')
      if (caps.supportsNativeTools) {
        console.log(`[${this.type}] Routing to native tool calling (model=${nativeModelConfig.model})`)
        return this.executeWithNativeTools(task, context)
      }
    }

    const startTime = Date.now()
    const modelConfig = LLMFactory.getAgentConfig(this.type)
    const permConfig = getAgentPermissions(this.type)
    const registry = getMcpRegistry()
    const localProvider = getLocalToolProvider()

    // Get only the tools this agent is allowed to use
    // When a mode is active, use mode-based filtering; otherwise fall back to agent type
    const allTools = [...localProvider.getTools(), ...registry.getAllTools()]
    const modeConfig = context.mode ? getModeRegistry().get(context.mode) : undefined
    const allowedTools = modeConfig
      ? filterToolsForMode(modeConfig, allTools)
      : filterToolsForAgent(this.type, allTools)

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

    // Loop detection & safety constants
    const TIMEOUT_MS = permConfig.timeoutMs ?? 5 * 60 * 1000
    const MAX_LOOP_REPEATS = 3
    const MAX_TOOL_FREQUENCY = 8
    const MAX_CONSECUTIVE_SAME = 5
    const ABSOLUTE_MAX_STEPS = 100
    const SOFT_WARNING_STEP = 50
    const toolCallHistory: Array<{ tool: string; argsHash: string }> = []
    const toolFrequency: Map<string, number> = new Map()
    let stuckWarningGiven = false

    // Phase 6: Enhanced error recovery
    const repetitionDetector = new ToolRepetitionDetector(3)
    const mistakes: MistakeCounters = createMistakeCounters()

    // File registry for smart dedup & content tracking
    const fileRegistry = new Map<string, FileRegistryEntry>()
    const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase()
    const getReadPath = (args: Record<string, unknown>): string | null =>
      (args.path as string) ?? (args.file_path as string) ?? null

    // File context tracker for staleness detection & environment reporting
    const fileTracker = new FileContextTracker()
    let condensationPending = false // flag set when condense tool is called

    // Checkpoint service for undo/rollback (Phase 9)
    const checkpointService = getCheckpointService()
    // Resolve working directory: explicit context > detectWorkspace() > cwd
    const workDir = context.workDir
      ?? detectWorkspace(task.description, context.parentTask, this.getBrainwaveHomeDir())

    // .brainwaveignore — load ignore patterns for file access blocking (Phase 12)
    const instructionMgr = getInstructionManager()
    const ignoreMatcher = await instructionMgr.getIgnoreMatcher(workDir)

    // Custom instructions — load once for the entire loop (Phase 12)
    const customInstructionBlock = await instructionMgr.buildBlock({
      workDir,
      mode: context.mode,
    })

    // Initialize conversation manager with capped budget
    const rawContextLimit = calculateBudget(model, 0).contextLimit
    const contextLimit = Math.min(rawContextLimit, MAX_INPUT_BUDGET)
    const conversation = new ConversationManager(contextLimit, 8_000)

    console.log(`[${this.type}] executeWithTools | taskId=${context.taskId} | model=${model} | tools=${allowedTools.length} | timeout=${Math.round(TIMEOUT_MS / 1000)}s | contextLimit=${formatTokenCount(contextLimit)} (raw=${formatTokenCount(rawContextLimit)})`)
    console.log(`[${this.type}] Task: "${task.description.slice(0, 200)}"`)

    try {
      // ── Build initial context ──
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

      let historyContext = ''
      if (context.conversationHistory && context.conversationHistory.length > 0) {
        const recent = context.conversationHistory.slice(-6)
        const lines = recent.map((msg) =>
          `${msg.role === 'user' ? 'User' : 'Brainwave'}: ${msg.content}`
        ).join('\n')
        historyContext = `\n\nRECENT CONVERSATION (use this to understand references like "try again", "do that", etc.):\n${lines}\n`
      }

      let blackboardContext = ''
      if (context.blackboard) {
        blackboardContext = context.blackboard.board.formatForPrompt(
          context.blackboard.planId,
          this.type,
          context.taskId
        )
      }

      // ── Planning guidance ──
      // Phase 13: Removed auto-call to sequential_thinking MCP tool.
      // The model is encouraged to reason in prose before tool calls instead.
      // If the model wants to plan, it can call sequential_thinking itself.

      // ── Build initial user message with environment details ──
      const envDetails = await getEnvironmentDetails({
        workDir,
        brainwaveHomeDir: this.getBrainwaveHomeDir(),
        contextLimitTokens: contextLimit,
        fileTracker,
        includeTree: true,
        treeMaxDepth: 3,
        treeMaxEntries: 200,
      })

      const initialMessage =
        `TASK: ${task.description}\n${parentContext}${historyContext}${priorContext}${blackboardContext}\n${envDetails}\n` +
        `Begin working on this task. Use the XML tool protocol to call tools.\n` +
        `For file/directory operations, use local:: tools (e.g. local::file_read, local::file_write, local::create_directory).\n` +
        `When done, use <attempt_completion> to signal completion with your final answer.`

      conversation.addMessage('user', initialMessage)

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

        // ── Timeout check ──
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

        // ── Handle voluntary condensation (condense tool was called) ──
        if (condensationPending) {
          condensationPending = false
          console.log(`[${this.type}] Step ${step}: Condense tool triggered — performing LLM condensation`)
          await this.performCondensation(conversation, context, fileRegistry, fileTracker)
        }

        // ── Token budget check & proactive condensation ──
        if (step > 1 && conversation.isNearBudget(0.75)) {
          const usagePct = (conversation.getUsageRatio() * 100).toFixed(0)
          console.log(
            `[${this.type}] Step ${step}: Conversation at ${usagePct}% of budget (${formatTokenCount(conversation.getTokenCount())}) — triggering LLM condensation`
          )
          await this.performCondensation(conversation, context, fileRegistry, fileTracker)

          // If still over budget after LLM condensation, apply heuristic compaction on file registry
          if (conversation.isNearBudget(0.90)) {
            const targetFree = Math.floor(conversation.getTokenCount() * 0.25)
            const compactionResult = compactContext(fileRegistry, toolResults, targetFree, step)
            if (compactionResult.tokensFreed > 0) {
              // Update file registry with compacted version
              fileRegistry.clear()
              for (const [k, v] of compactionResult.fileRegistry) {
                fileRegistry.set(k, v)
              }
              conversation.addSystemNotice(buildCompactionNotice(compactionResult))
              console.log(`[${this.type}] Heuristic file compaction: ${compactionResult.summary}`)
            }
          }
        }

        // ── LLM call with streaming conversation history ──
        // Uses adapter.stream() instead of adapter.complete() so tokens are
        // emitted to the frontend in real-time via agent:stream-chunk events.
        const response = await this.streamWithHistory(
          conversation.getMessages(),
          context,
          {
            temperature: modelConfig?.temperature ?? 0.1,
            maxTokens: modelConfig?.maxTokens,
          },
          undefined, // onChunk — handled internally by streamWithHistory via bus events
          customInstructionBlock || undefined,
        )

        totalTokensIn += response.tokensIn
        totalTokensOut += response.tokensOut
        model = response.model

        // Add assistant response to conversation
        conversation.addMessage('assistant', response.content)

        // ── Parse response with XML parser ──
        const parsed = parseAssistantMessage(response.content)

        // Extract reasoning text for UI display
        if (parsed.textContent) {
          const reasoning = parsed.textContent.slice(0, 200).replace(/\n+/g, ' ').trim()
          if (reasoning.length > 10) {
            this.bus.emitEvent('agent:acting', {
              agentType: this.type,
              taskId: context.taskId,
              action: `💭 ${reasoning.slice(0, 150)}`,
            })
          }
        }

        // ── Check for completion signal ──
        if (parsed.completionResult) {
          console.log(`[${this.type}] Completion at step ${step}: "${parsed.completionResult.slice(0, 200)}..."`)
          const anySuccess = toolResults.some((t) => t.success)

          if (context.blackboard) {
            context.blackboard.board.write(
              context.blackboard.planId,
              'final-summary',
              parsed.completionResult,
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
            parsed.completionResult,
            anySuccess ? 0.9 : 0.7,
            totalTokensIn, totalTokensOut, model, startTime, artifacts
          )
        }

        // ── Check for JSON done signal (backward compatibility) ──
        const jsonDoneSignal = this.parseDoneSignal(response.content)
        if (jsonDoneSignal) {
          console.log(`[${this.type}] JSON done signal at step ${step} (legacy): "${jsonDoneSignal.slice(0, 200)}..."`)
          const anySuccess = toolResults.some((t) => t.success)

          if (context.blackboard) {
            context.blackboard.board.write(
              context.blackboard.planId,
              'final-summary',
              jsonDoneSignal,
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
            jsonDoneSignal,
            anySuccess ? 0.9 : 0.7,
            totalTokensIn, totalTokensOut, model, startTime, artifacts
          )
        }

        // ── Process XML tool calls ──
        if (parsed.toolUses.length > 0) {
          const READ_OP_NAMES = new Set(['file_read', 'directory_list', 'read_file', 'read_multiple_files', 'search_files', 'list_code_definition_names'])

          // ── Phase 13: Parallel read operations ──
          // If the model emitted multiple tool calls and they are ALL read-only,
          // execute them in parallel to reduce wall-clock time.
          if (parsed.toolUses.length > 1) {
            const allCalls = parsed.toolUses.map(xu => xmlToolToLocalCall(xu))
            const allReadOnly = allCalls.every(c => READ_OP_NAMES.has(c.tool.split('::').pop() ?? c.tool))

            if (allReadOnly) {
              console.log(`[${this.type}] Step ${step}: Parallel read batch (${allCalls.length} tools)`)
              const batchResults = await Promise.all(allCalls.map(async (tc) => {
                const baseName = tc.tool.split('::').pop() ?? tc.tool
                const perm = canAgentCallTool(this.type, tc.tool)
                if (!perm.allowed) {
                  return { tool: tc.tool, success: false, content: `PERMISSION DENIED: ${perm.reason}` }
                }
                // Check .brainwaveignore
                if (ignoreMatcher.hasPatterns) {
                  const tp = getReadPath(tc.args)
                  if (tp && ignoreMatcher.isIgnored(tp)) {
                    return { tool: tc.tool, success: false, content: `ACCESS BLOCKED: "${tp}" excluded by .brainwaveignore` }
                  }
                }
                // Check cache
                const rp = getReadPath(tc.args)
                const nr = rp ? normPath(rp) : null
                const cached = nr ? fileRegistry.get(nr) : null
                if (cached) {
                  return { tool: tc.tool, success: true, content: cached.content }
                }
                // Execute
                const res = tc.tool.startsWith('local::')
                  ? await localProvider.callTool(tc.tool.split('::')[1], tc.args, { taskId: context.taskId })
                  : await registry.callTool(tc.tool, tc.args)
                // Cache result
                if (res.success && rp) {
                  fileRegistry.set(normPath(rp), { content: res.content, step })
                  fileTracker.trackFileRead(rp, step)
                }
                return { tool: tc.tool, success: res.success, content: res.content }
              }))

              // Add all results to conversation and tracking
              for (const br of batchResults) {
                toolResults.push(br)
                toolCallHistory.push({ tool: br.tool, argsHash: JSON.stringify({}) })
                const freq = (toolFrequency.get(br.tool.split('::').pop() ?? br.tool) ?? 0) + 1
                toolFrequency.set(br.tool.split('::').pop() ?? br.tool, freq)
                const brSummary = br.success ? `Read ${br.content.split('\n').length} lines` : br.content.slice(0, 100)
                this.bus.emitEvent('agent:tool-result', {
                  agentType: this.type,
                  taskId: context.taskId,
                  tool: br.tool,
                  success: br.success,
                  summary: brSummary,
                  step,
                })
                this.emitToolCallInfo({
                  taskId: context.taskId, step, tool: br.tool,
                  args: {}, success: br.success, summary: brSummary,
                  resultPreview: br.content.slice(0, 300),
                })
              }
              conversation.addToolResults(batchResults)
              continue
            }
          }

          // Process the FIRST tool call (one tool per turn for non-read ops)
          const xmlToolUse = parsed.toolUses[0]
          const localCall = xmlToolToLocalCall(xmlToolUse)
          const toolCall = localCall

          const toolBaseName = toolCall.tool.split('::').pop() ?? toolCall.tool
          const argsHash = JSON.stringify(toolCall.args ?? {})
          const callSig = `${toolCall.tool}:${argsHash}`
          const isReadOp = ['file_read', 'directory_list', 'read_file', 'read_multiple_files'].includes(toolBaseName)

          // ── Permission check ──
          const perm = canAgentCallTool(this.type, toolCall.tool)
          if (!perm.allowed) {
            console.warn(`[${this.type}] BLOCKED tool call: ${toolCall.tool} — ${perm.reason}`)
            toolResults.push({
              tool: toolCall.tool,
              success: false,
              content: `PERMISSION DENIED: ${perm.reason}`,
            })
            conversation.addToolResult(toolCall.tool, false, `PERMISSION DENIED: ${perm.reason}\nTry using a local:: tool instead.`)
            continue
          }

          // ── .brainwaveignore check (Phase 12) ──
          if (ignoreMatcher.hasPatterns) {
            const targetPath = getReadPath(toolCall.args)
            if (targetPath && ignoreMatcher.isIgnored(targetPath)) {
              const msg = `ACCESS BLOCKED: "${targetPath}" is excluded by .brainwaveignore. Choose a different file or ask the user to update the ignore rules.`
              console.warn(`[${this.type}] IGNORED file: ${targetPath}`)
              toolResults.push({ tool: toolCall.tool, success: false, content: msg })
              conversation.addToolResult(toolCall.tool, false, msg)
              continue
            }
          }

          // ── Duplicate read interception ──
          if (isReadOp) {
            const readPath = getReadPath(toolCall.args)
            const normalizedRead = readPath ? normPath(readPath) : null
            const cachedFile = normalizedRead ? fileRegistry.get(normalizedRead) : null

            if (cachedFile) {
              let excerpt = cachedFile.content
              const startLine = toolCall.args.start_line as number | undefined
              const endLine = toolCall.args.end_line as number | undefined
              if (startLine || endLine) {
                const lines = cachedFile.content.split('\n')
                const s = Math.max(0, (startLine ?? 1) - 1)
                const e = Math.min(lines.length, endLine ?? lines.length)
                excerpt = `[Lines ${s + 1}-${e} of ${lines.length} total]\n` + lines.slice(s, e).join('\n')
              }

              console.log(`[${this.type}] Step ${step}: Cache hit — serving "${readPath}" from registry`)
              toolResults.push({ tool: toolCall.tool, success: true, content: excerpt })
              toolCallHistory.push({ tool: toolCall.tool, argsHash })
              conversation.addToolResult(toolCall.tool, true, excerpt)

              // Cache hits count towards loop detection
              const cacheFreq = (toolFrequency.get(toolBaseName) ?? 0) + 1
              toolFrequency.set(toolBaseName, cacheFreq)
              if (cacheFreq >= MAX_TOOL_FREQUENCY) {
                console.warn(`[${this.type}] Loop detected (cache hit frequency): "${toolBaseName}" called ${cacheFreq}×`)
                loopDetected = true
                break
              }

              const cacheSummary = `Read from cache (${cachedFile.content.split('\n').length} lines)`
              this.bus.emitEvent('agent:tool-result', {
                agentType: this.type,
                taskId: context.taskId,
                tool: toolCall.tool,
                success: true,
                summary: cacheSummary,
                step,
              })
              this.emitToolCallInfo({
                taskId: context.taskId, step, tool: toolCall.tool,
                args: toolCall.args, success: true, summary: cacheSummary,
                duration: 0, resultPreview: excerpt.slice(0, 300),
              })
              continue
            }
          }

          // ── Loop detection (4 strategies) ──
          toolCallHistory.push({ tool: toolCall.tool, argsHash })
          const freq = (toolFrequency.get(toolBaseName) ?? 0) + 1
          toolFrequency.set(toolBaseName, freq)

          // Strategy 0: ToolRepetitionDetector (consecutive identical, stable-serialized)
          const repCheck = repetitionDetector.check({ tool: toolCall.tool, args: toolCall.args ?? {} })
          if (repCheck.isRepetition) {
            loopDetected = true
            console.warn(`[${this.type}] Loop detected (repetition detector): "${toolBaseName}" called ${repCheck.count}× consecutively with identical args`)
            break
          }

          // Strategy 1: Exact match (history-wide)
          const exactRepeatCount = toolCallHistory.filter(h => `${h.tool}:${h.argsHash}` === callSig).length
          if (exactRepeatCount >= MAX_LOOP_REPEATS) {
            loopDetected = true
            console.warn(`[${this.type}] Loop detected (exact match): "${toolBaseName}" called ${exactRepeatCount}× with identical args`)
            break
          }

          // Strategy 2: Per-tool frequency
          if (freq >= MAX_TOOL_FREQUENCY) {
            if (!stuckWarningGiven) {
              stuckWarningGiven = true
              console.warn(`[${this.type}] Stuck warning: "${toolBaseName}" called ${freq} times`)
              toolResults.push({ tool: toolCall.tool, success: false, content: `STUCK DETECTION: You called "${toolBaseName}" ${freq} times.` })
              conversation.addSystemNotice(
                `You have called "${toolBaseName}" ${freq} times. You may be looping.\n` +
                `Consider signaling completion with <attempt_completion> or try a completely different approach.`
              )
              continue
            }
            loopDetected = true
            console.warn(`[${this.type}] Loop detected (frequency): "${toolBaseName}" called ${freq}×`)
            break
          }

          // Strategy 3: Consecutive same-tool
          if (toolCallHistory.length >= MAX_CONSECUTIVE_SAME) {
            const lastN = toolCallHistory.slice(-MAX_CONSECUTIVE_SAME)
            const allSameTool = lastN.every(h => h.tool === toolCall.tool)
            if (allSameTool) {
              if (!stuckWarningGiven) {
                stuckWarningGiven = true
                console.warn(`[${this.type}] Stuck warning: "${toolBaseName}" called ${MAX_CONSECUTIVE_SAME}× consecutively`)
                toolResults.push({ tool: toolCall.tool, success: false, content: `STUCK: "${toolBaseName}" called ${MAX_CONSECUTIVE_SAME}× in a row.` })
                conversation.addSystemNotice(
                  `You called "${toolBaseName}" ${MAX_CONSECUTIVE_SAME} times in a row. You are stuck.\n` +
                  `STOP and signal completion with <attempt_completion> or try a completely different tool.`
                )
                continue
              }
              loopDetected = true
              console.warn(`[${this.type}] Loop detected (consecutive): "${toolBaseName}" called ${MAX_CONSECUTIVE_SAME}× in a row`)
              break
            }
          }

          // General mistake limit check
          if (mistakes.general >= MAX_GENERAL_MISTAKES) {
            loopDetected = true
            console.warn(`[${this.type}] Too many general mistakes (${mistakes.general}) — terminating loop`)
            break
          }

          // ── Handle delegation tool call ──
          if (toolCall.tool === 'delegate_to_agent' || xmlToolUse.tool === 'delegate_to_agent') {
            const targetAgent = (toolCall.args?.agent ?? xmlToolUse.params.agent) as AgentType | undefined
            const delegatedTask = (toolCall.args?.task ?? xmlToolUse.params.task) as string | undefined

            if (!targetAgent || !delegatedTask) {
              toolResults.push({ tool: 'delegate_to_agent', success: false, content: 'INVALID ARGS: requires agent and task parameters' })
              conversation.addToolResult('delegate_to_agent', false, 'INVALID ARGS: requires agent and task parameters')
            } else if (!context.delegateFn) {
              toolResults.push({ tool: 'delegate_to_agent', success: false, content: 'DELEGATION UNAVAILABLE in this context' })
              conversation.addToolResult('delegate_to_agent', false, 'DELEGATION UNAVAILABLE in this context')
            } else if (!canDelegateAtDepth(context.delegationDepth ?? 0)) {
              toolResults.push({ tool: 'delegate_to_agent', success: false, content: 'DELEGATION DEPTH EXCEEDED' })
              conversation.addToolResult('delegate_to_agent', false, 'DELEGATION DEPTH EXCEEDED — complete the task yourself')
            } else {
              const delegationPerm = canDelegate(this.type, targetAgent)
              if (!delegationPerm.allowed) {
                toolResults.push({ tool: 'delegate_to_agent', success: false, content: `DELEGATION DENIED: ${delegationPerm.reason}` })
                conversation.addToolResult('delegate_to_agent', false, `DELEGATION DENIED: ${delegationPerm.reason}`)
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
                  const delegSuccess = delegationResult.status === 'success' || delegationResult.status === 'partial'

                  toolResults.push({ tool: `delegate_to_agent:${targetAgent}`, success: delegSuccess, content: outputStr })
                  totalTokensIn += delegationResult.tokensIn
                  totalTokensOut += delegationResult.tokensOut

                  conversation.addToolResult(`delegate_to_agent:${targetAgent}`, delegSuccess, outputStr)

                  if (context.blackboard && delegSuccess) {
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
                  const errMsg = `DELEGATION FAILED: ${err instanceof Error ? err.message : String(err)}`
                  toolResults.push({ tool: `delegate_to_agent:${targetAgent}`, success: false, content: errMsg })
                  conversation.addToolResult(`delegate_to_agent:${targetAgent}`, false, errMsg)
                }
              }
            }

            const delegSummary = toolResults[toolResults.length - 1].success
              ? `Delegated to ${targetAgent ?? 'agent'} — completed`
              : `Delegation to ${targetAgent ?? 'agent'} failed`
            this.bus.emitEvent('agent:tool-result', {
              agentType: this.type,
              taskId: context.taskId,
              tool: toolResults[toolResults.length - 1].tool,
              success: toolResults[toolResults.length - 1].success,
              summary: delegSummary,
              step,
            })
            this.emitToolCallInfo({
              taskId: context.taskId, step,
              tool: toolResults[toolResults.length - 1].tool,
              args: toolCall.args, success: toolResults[toolResults.length - 1].success,
              summary: delegSummary,
              resultPreview: toolResults[toolResults.length - 1].content.slice(0, 300),
            })
            continue
          }

          // ── Handle parallel delegation (use_subagents) ──
          if (toolCall.tool === 'use_subagents' || xmlToolUse.tool === 'use_subagents') {
            const tasksRaw = toolCall.args?.tasks ?? xmlToolUse.params.tasks
            let parsedTasks: Array<{ agent: string; task: string }> = []

            // Parse tasks from JSON string or array
            try {
              if (typeof tasksRaw === 'string') {
                parsedTasks = JSON.parse(tasksRaw)
              } else if (Array.isArray(tasksRaw)) {
                parsedTasks = tasksRaw as Array<{ agent: string; task: string }>
              }
            } catch {
              toolResults.push({ tool: 'use_subagents', success: false, content: 'INVALID ARGS: tasks must be a valid JSON array of { agent, task } objects' })
              conversation.addToolResult('use_subagents', false, 'INVALID ARGS: tasks must be a valid JSON array of { agent, task } objects')
              continue
            }

            if (!Array.isArray(parsedTasks) || parsedTasks.length === 0) {
              toolResults.push({ tool: 'use_subagents', success: false, content: 'INVALID ARGS: tasks must be a non-empty array' })
              conversation.addToolResult('use_subagents', false, 'INVALID ARGS: tasks must be a non-empty array')
              continue
            }

            if (!context.parallelDelegateFn) {
              toolResults.push({ tool: 'use_subagents', success: false, content: 'PARALLEL DELEGATION UNAVAILABLE in this context' })
              conversation.addToolResult('use_subagents', false, 'PARALLEL DELEGATION UNAVAILABLE in this context')
              continue
            }

            if (!canDelegateAtDepth(context.delegationDepth ?? 0)) {
              toolResults.push({ tool: 'use_subagents', success: false, content: 'DELEGATION DEPTH EXCEEDED' })
              conversation.addToolResult('use_subagents', false, 'DELEGATION DEPTH EXCEEDED — complete the tasks yourself')
              continue
            }

            // Validate each task's agent permission
            const validatedTasks: Array<{ agent: AgentType; task: string }> = []
            const rejections: string[] = []
            for (const t of parsedTasks.slice(0, 5)) { // Cap at 5
              const perm = canDelegate(this.type, t.agent as AgentType)
              if (!perm.allowed) {
                rejections.push(`"${t.agent}": ${perm.reason}`)
              } else {
                validatedTasks.push({ agent: t.agent as AgentType, task: t.task })
              }
            }

            if (validatedTasks.length === 0) {
              const msg = `ALL DELEGATIONS DENIED:\n${rejections.join('\n')}`
              toolResults.push({ tool: 'use_subagents', success: false, content: msg })
              conversation.addToolResult('use_subagents', false, msg)
              continue
            }

            console.log(`[${this.type}] Step ${step}: Parallel delegation → ${validatedTasks.length} sub-agents: ${validatedTasks.map(t => t.agent).join(', ')}`)
            this.bus.emitEvent('agent:acting', {
              agentType: this.type,
              taskId: context.taskId,
              action: `Parallel delegation: ${validatedTasks.length} sub-agents (step ${step})`,
            })

            try {
              const results = await context.parallelDelegateFn(validatedTasks)

              // Build combined result
              const resultParts: string[] = []
              let allSuccess = true
              for (let i = 0; i < results.length; i++) {
                const r = results[i]
                const t = validatedTasks[i]
                const outputStr = typeof r.output === 'string' ? r.output : JSON.stringify(r.output)
                const ok = r.status === 'success' || r.status === 'partial'
                if (!ok) allSuccess = false

                totalTokensIn += r.tokensIn
                totalTokensOut += r.tokensOut

                resultParts.push(
                  `--- Sub-agent: ${t.agent} (${r.status}) ---\n` +
                  `Task: ${t.task}\n` +
                  `Result:\n${outputStr}`
                )

                if (context.blackboard && ok) {
                  context.blackboard.board.write(
                    context.blackboard.planId,
                    `parallel-${t.agent}-${i}-result`,
                    outputStr,
                    this.type,
                    context.taskId
                  )
                }
              }

              const combinedResult = resultParts.join('\n\n')
              toolResults.push({ tool: 'use_subagents', success: allSuccess, content: combinedResult })
              conversation.addToolResult('use_subagents', allSuccess, combinedResult)

              if (rejections.length > 0) {
                conversation.addSystemNotice(`Note: ${rejections.length} sub-task(s) were skipped due to permission rules:\n${rejections.join('\n')}`)
              }

              artifacts.push({
                type: 'json',
                name: `parallel-delegation-step${step}`,
                content: JSON.stringify({
                  tasks: validatedTasks.map((t, i) => ({
                    agent: t.agent,
                    task: t.task,
                    status: results[i].status,
                    confidence: results[i].confidence,
                  })),
                  allSuccess,
                  rejections,
                }, null, 2),
              })
            } catch (err) {
              const errMsg = `PARALLEL DELEGATION FAILED: ${err instanceof Error ? err.message : String(err)}`
              toolResults.push({ tool: 'use_subagents', success: false, content: errMsg })
              conversation.addToolResult('use_subagents', false, errMsg)
            }

            const parSummary = toolResults[toolResults.length - 1].success
              ? `Parallel delegation (${validatedTasks.length} agents) — completed`
              : `Parallel delegation failed`
            this.bus.emitEvent('agent:tool-result', {
              agentType: this.type,
              taskId: context.taskId,
              tool: 'use_subagents',
              success: toolResults[toolResults.length - 1].success,
              summary: parSummary,
              step,
            })
            this.emitToolCallInfo({
              taskId: context.taskId, step, tool: 'use_subagents',
              args: toolCall.args, success: toolResults[toolResults.length - 1].success,
              summary: parSummary,
              resultPreview: toolResults[toolResults.length - 1].content.slice(0, 300),
            })
            continue
          }

          // ── Execute the tool ──
          // ── Approval gate (between permission check and execution) ──
          const approvalSettings: ApprovalSettings = this.getApprovalSettings()
          const mcpAutoApproved = registry.isToolAutoApproved(toolCall.tool)
          if (requiresApproval(toolCall.tool, approvalSettings, mcpAutoApproved)) {
            console.log(`[${this.type}] Step ${step}: Approval required for ${toolCall.tool}`)

            const approval = await requestApproval(
              context.taskId,
              this.type,
              toolCall.tool,
              toolCall.args,
            )

            if (!approval.approved) {
              const rejectMsg = `The user rejected this operation.${approval.reason ? ` Reason: ${approval.reason}` : ''}`
              toolResults.push({ tool: toolCall.tool, success: false, content: rejectMsg })
              conversation.addToolResult(toolCall.tool, false, rejectMsg)

              // If user provided feedback, inject it so the model can adapt
              if (approval.feedback) {
                conversation.addMessage('user', approval.feedback)
              }

              const rejectSummary = `Rejected by user${approval.reason ? `: ${approval.reason}` : ''}`
              this.bus.emitEvent('agent:tool-result', {
                agentType: this.type,
                taskId: context.taskId,
                tool: toolCall.tool,
                success: false,
                summary: rejectSummary,
                step,
              })
              this.emitToolCallInfo({
                taskId: context.taskId, step, tool: toolCall.tool,
                args: toolCall.args, success: false, summary: rejectSummary,
                duration: 0,
              })
              continue
            }

            // If user provided feedback alongside approval, inject it
            if (approval.feedback) {
              conversation.addMessage('user', approval.feedback)
            }
          }

          console.log(`[${this.type}] Step ${step}: Calling ${toolCall.tool} args=${JSON.stringify(toolCall.args).slice(0, 200)}`)

          const toolStartTime = Date.now()
          const result = toolCall.tool.startsWith('local::')
            ? await localProvider.callTool(toolCall.tool.split('::')[1], toolCall.args, { taskId: context.taskId })
            : await registry.callTool(toolCall.tool, toolCall.args)
          const toolDuration = Date.now() - toolStartTime

          console.log(`[${this.type}] Step ${step}: ${toolCall.tool} → ${result.success ? 'SUCCESS' : 'FAILED'} (${toolDuration}ms) | ${result.content.slice(0, 200)}`)

          toolResults.push({
            tool: toolCall.tool,
            success: result.success,
            content: result.content,
          })

          // Add tool result to conversation
          conversation.addToolResult(toolCall.tool, result.success, result.content)

          // ── Progressive diff fallback for edit failures ──
          if (!result.success && ['file_edit', 'apply_patch'].includes(toolBaseName)) {
            const editPath = getReadPath(toolCall.args) ?? 'unknown'
            const errCount = recordFileError(mistakes, 'diff', editPath)
            mistakes.general++

            // Re-read the file from registry or disk and provide progressive guidance
            const cached = fileRegistry.get(normPath(editPath))
            if (cached) {
              const fallbackMsg = buildDiffFallbackMessage(editPath, errCount, cached.content)
              conversation.addSystemNotice(fallbackMsg)
              console.log(`[${this.type}] Diff fallback (attempt ${errCount}) for ${editPath}`)
            }
          } else if (!result.success) {
            mistakes.general++
          }

          // Auto-write successful results to blackboard
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
          const mainSummary = this.summarizeForUI(toolCall.tool, toolCall.args, result)
          this.bus.emitEvent('agent:tool-result', {
            agentType: this.type,
            taskId: context.taskId,
            tool: toolCall.tool,
            success: result.success,
            summary: mainSummary,
            step,
          })
          this.emitToolCallInfo({
            taskId: context.taskId, step, tool: toolCall.tool,
            args: toolCall.args, success: result.success, summary: mainSummary,
            duration: toolDuration,
            resultPreview: result.content.slice(0, 300),
          })

          // Update file registry for dedup
          if (result.success) {
            if (isReadOp) {
              const readPath = getReadPath(toolCall.args)
              if (readPath) {
                const hasRange = toolCall.args.start_line || toolCall.args.end_line
                const existing = fileRegistry.get(normPath(readPath))
                if (!existing || !hasRange) {
                  fileRegistry.set(normPath(readPath), { content: result.content, step })
                }
                fileTracker.trackFileRead(readPath, step)
              }
            }

            // After file writes: refresh registry with new content
            const isWriteOp = ['file_edit', 'file_write', 'file_create'].includes(toolBaseName)
            if (isWriteOp) {
              const writePath = getReadPath(toolCall.args)
              if (writePath) {
                try {
                  const freshContent = await fsReadFile(writePath, 'utf-8')
                  fileRegistry.set(normPath(writePath), { content: freshContent, step })
                } catch (err) {
                  fileRegistry.delete(normPath(writePath))
                }
                fileTracker.trackFileEdit(writePath, step)

                // Phase 9: Checkpoint after write operations
                try {
                  const checkpoint = await checkpointService.createCheckpoint(
                    workDir,
                    context.taskId,
                    step,
                    toolBaseName,
                    writePath,
                  )
                  if (checkpoint) {
                    this.bus.emitEvent('agent:checkpoint', {
                      taskId: context.taskId,
                      checkpointId: checkpoint.id,
                      step,
                      tool: toolBaseName,
                      filePath: writePath,
                      commitHash: checkpoint.commitHash,
                    })
                  }
                } catch (cpErr) {
                  console.warn(`[${this.type}] Checkpoint failed (non-fatal):`, cpErr instanceof Error ? cpErr.message : cpErr)
                }
              }
            }

            // Detect shell commands that read file contents (cat, type, head, tail, less)
            if (toolBaseName === 'shell_execute') {
              const cmd = String(toolCall.args.command ?? '').trim()
              // Match: cat/type/head/tail/less followed by a filepath (with optional flags)
              // Rejects piped/chained commands (|, &, ;, >) to avoid false positives
              const readCmdMatch = cmd.match(/^(?:cat|type|less|more)\s+(?:-[a-zA-Z0-9]+\s+)*"?([^"|\n&;>]+?)"?\s*$/i)
                ?? cmd.match(/^(?:head|tail)\s+(?:-[a-zA-Z0-9]+\s+)*"?([^"|\n&;>]+?)"?\s*$/i)
              if (readCmdMatch && result.content && !result.content.startsWith('Error:')) {
                const readPath = readCmdMatch[1].trim()
                if (readPath && !readPath.startsWith('-')) {
                  fileRegistry.set(normPath(readPath), { content: result.content, step })
                  fileTracker.trackFileRead(readPath, step)
                }
              }
            }
          }

          // ── Wire condense tool to actual LLM condensation ──
          if (toolBaseName === 'condense') {
            condensationPending = true
          }

          // ── Periodic context usage notice (every 5 steps) ──
          if (step > 0 && step % 5 === 0) {
            const ctxSummary = conversation.getContextSummary()
            const staleFiles = fileTracker.getStaleFiles()
            let notice = `Context usage: ${ctxSummary.usagePercent}% (${formatTokenCount(ctxSummary.tokensUsed)} / ${formatTokenCount(ctxSummary.budgetTotal)} tokens) | ${ctxSummary.messageCount} messages`
            if (staleFiles.length > 0) {
              notice += `\n⚠️ Stale files (modified externally since last read): ${staleFiles.join(', ')}`
            }
            if (ctxSummary.condensations > 0) {
              notice += `\nCondensation count: ${ctxSummary.condensations}`
            }
            conversation.addSystemNotice(notice)

            // Emit context usage event for renderer's context window indicator
            this.bus.emitEvent('agent:context-usage', {
              taskId: context.taskId,
              agentType: this.type,
              tokensUsed: ctxSummary.tokensUsed,
              budgetTotal: ctxSummary.budgetTotal,
              usagePercent: ctxSummary.usagePercent,
              messageCount: ctxSummary.messageCount,
              condensations: ctxSummary.condensations,
              step,
            })
          }

          // ── Phase 13: Soft warning at step 50 ──
          if (step === SOFT_WARNING_STEP) {
            conversation.addSystemNotice(
              `⚠️ You have used ${step} of ${ABSOLUTE_MAX_STEPS} tool calls. ` +
              `Consider wrapping up soon. If the task is complete, use <attempt_completion>. ` +
              `If you need more steps, you can continue but be efficient.`
            )
          }

          continue
        }

        // ── No tool call and no completion — try JSON tool call fallback ──
        const jsonToolCall = this.parseToolCall(response.content)
        if (jsonToolCall) {
          console.log(`[${this.type}] Step ${step}: Parsed JSON tool call (legacy): ${jsonToolCall.tool}`)
          // Re-inject as a nudge to use XML format, but also execute it
          const toolBaseName = jsonToolCall.tool.split('::').pop() ?? jsonToolCall.tool
          const perm = canAgentCallTool(this.type, jsonToolCall.tool)

          if (perm.allowed) {
            const jsonStartTime = Date.now()
            const result = jsonToolCall.tool.startsWith('local::')
              ? await localProvider.callTool(jsonToolCall.tool.split('::')[1], jsonToolCall.args)
              : await registry.callTool(jsonToolCall.tool, jsonToolCall.args)
            const jsonDuration = Date.now() - jsonStartTime

            toolResults.push({ tool: jsonToolCall.tool, success: result.success, content: result.content })
            conversation.addToolResult(jsonToolCall.tool, result.success,
              result.content + '\n\nNote: Please use the XML tool format for future tool calls. Example:\n<read_file>\n<path>/path/to/file</path>\n</read_file>')

            // Update file registry
            if (result.success) {
              const isReadOp = ['file_read', 'directory_list', 'read_file'].includes(toolBaseName)
              if (isReadOp) {
                const readPath = getReadPath(jsonToolCall.args)
                if (readPath) fileRegistry.set(normPath(readPath), { content: result.content, step })
              }
            }

            const jsonSummary = this.summarizeForUI(jsonToolCall.tool, jsonToolCall.args, result)
            this.bus.emitEvent('agent:tool-result', {
              agentType: this.type,
              taskId: context.taskId,
              tool: jsonToolCall.tool,
              success: result.success,
              summary: jsonSummary,
              step,
            })
            this.emitToolCallInfo({
              taskId: context.taskId, step, tool: jsonToolCall.tool,
              args: jsonToolCall.args, success: result.success, summary: jsonSummary,
              duration: jsonDuration,
              resultPreview: result.content.slice(0, 300),
            })
            continue
          }
        }

        // ── Prose-to-tool fallback: extract tool calls from markdown ──
        // Models like minimax output code in markdown fences instead of XML tool blocks.
        // Before nudging, try to extract synthetic tool calls from the prose.
        const proseExtraction = extractToolsFromProse(response.content)
        if (proseExtraction.toolCalls.length > 0) {
          console.log(`[${this.type}] Step ${step}: Prose extraction found ${proseExtraction.toolCalls.length} synthetic tool call(s)`)
          let proseToolSuccess = false
          const proseResults: string[] = []

          for (const syntheticCall of proseExtraction.toolCalls) {
            const toolBaseName = syntheticCall.tool.split('::').pop() ?? syntheticCall.tool
            const perm = canAgentCallTool(this.type, syntheticCall.tool)
            if (!perm.allowed) {
              console.log(`[${this.type}] Prose tool ${syntheticCall.tool} blocked: ${perm.reason}`)
              proseResults.push(`${toolBaseName}: PERMISSION DENIED — ${perm.reason}`)
              continue
            }

            // Check .brainwaveignore for file operations
            if (ignoreMatcher.hasPatterns && syntheticCall.args.path) {
              const tp = String(syntheticCall.args.path)
              if (ignoreMatcher.isIgnored(tp)) {
                proseResults.push(`${toolBaseName}: ACCESS BLOCKED by .brainwaveignore`)
                continue
              }
            }

            try {
              const proseStartTime = Date.now()
              const result = syntheticCall.tool.startsWith('local::')
                ? await localProvider.callTool(toolBaseName, syntheticCall.args)
                : await registry.callTool(syntheticCall.tool, syntheticCall.args)
              const proseDuration = Date.now() - proseStartTime

              toolResults.push({ tool: syntheticCall.tool, success: result.success, content: result.content })
              proseResults.push(`${toolBaseName} → ${result.success ? 'OK' : 'FAIL'}: ${result.content.slice(0, 150)}`)
              if (result.success) proseToolSuccess = true

              // Update file registry for read ops
              if (result.success) {
                const isReadOp = ['file_read', 'directory_list', 'read_file'].includes(toolBaseName)
                if (isReadOp) {
                  const readPath = getReadPath(syntheticCall.args)
                  if (readPath) fileRegistry.set(normPath(readPath), { content: result.content, step })
                }
              }

              const proseSummary = this.summarizeForUI(syntheticCall.tool, syntheticCall.args, result)
              this.bus.emitEvent('agent:tool-result', {
                agentType: this.type,
                taskId: context.taskId,
                tool: syntheticCall.tool,
                success: result.success,
                summary: proseSummary,
                step,
              })
              this.emitToolCallInfo({
                taskId: context.taskId, step, tool: syntheticCall.tool,
                args: syntheticCall.args as Record<string, string>,
                success: result.success, summary: proseSummary,
                duration: proseDuration,
                resultPreview: result.content.slice(0, 300),
              })
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err)
              proseResults.push(`${toolBaseName} → ERROR: ${errMsg.slice(0, 150)}`)
              toolResults.push({ tool: syntheticCall.tool, success: false, content: errMsg })
            }
          }

          // Feed results back to the model so it knows what happened
          const proseToolSummary = proseResults.join('\n')
          conversation.addToolResult(
            'prose-extraction',
            proseToolSuccess,
            `[Prose Extraction] Detected and executed ${proseExtraction.toolCalls.length} tool call(s) from your markdown output:\n${proseToolSummary}\n\n` +
            `Tip: For better reliability, use XML tool blocks directly. Example:\n` +
            `<write_to_file>\n<path>src/file.ts</path>\n<content>file content here</content>\n</write_to_file>`
          )

          // Reset no-tool-use counter since the model IS producing actionable output
          mistakes.noToolUse = 0

          // If the prose also had a completion signal, wrap up
          if (proseExtraction.completionResult && proseToolSuccess) {
            console.log(`[${this.type}] Prose extraction includes completion signal — finishing`)
            return this.buildToolResult(
              'success',
              proseExtraction.completionResult,
              0.8,
              totalTokensIn, totalTokensOut, model, startTime, artifacts
            )
          }

          continue
        }

        // If prose extraction found a completion signal but no tool calls,
        // treat it as an attempt_completion
        if (proseExtraction.completionResult) {
          console.log(`[${this.type}] Prose extraction found completion signal at step ${step}`)
          const anySuccess = toolResults.some(t => t.success)
          return this.buildToolResult(
            anySuccess ? 'success' : 'partial',
            proseExtraction.completionResult,
            anySuccess ? 0.8 : 0.6,
            totalTokensIn, totalTokensOut, model, startTime, artifacts
          )
        }

        // ── Pure prose response (no tool call, no completion) ──
        // Grace retry pattern: first N are soft nudges, then escalate, then abort
        if (step < ABSOLUTE_MAX_STEPS - 1) {
          mistakes.noToolUse++
          const isEscalated = mistakes.noToolUse > GRACE_RETRY_THRESHOLD

          // Hard abort: if model can't produce tool calls after many attempts,
          // stop wasting tokens and treat last response as final answer
          const NO_TOOL_USE_ABORT_THRESHOLD = 8
          if (mistakes.noToolUse >= NO_TOOL_USE_ABORT_THRESHOLD) {
            console.warn(`[${this.type}] Step ${step}: Model failed to use tools after ${mistakes.noToolUse} attempts — aborting to save tokens`)
            return this.buildToolResult(
              toolResults.some(t => t.success) ? 'partial' : 'failed',
              parsed.textContent || response.content || 'Model was unable to use the required tool format.',
              0.3,
              totalTokensIn, totalTokensOut, model, startTime, artifacts
            )
          }

          if (isEscalated) {
            mistakes.general++
            console.log(`[${this.type}] Step ${step}: No tool use (${mistakes.noToolUse}x, escalated). general=${mistakes.general}`)
            conversation.addMessage('user',
              `WARNING: You have responded ${mistakes.noToolUse} times without using a tool or signalling completion.\n` +
              `You MUST either:\n` +
              `1. Use an XML tool block to take action (e.g. <read_file><path>...</path></read_file>)\n` +
              `2. Signal completion: <attempt_completion><result>Your answer</result></attempt_completion>\n\n` +
              `Do NOT respond with only prose. If you are stuck, use attempt_completion to report what you know.`
            )
          } else {
            console.log(`[${this.type}] Step ${step}: No tool use (${mistakes.noToolUse}x, grace). Nudging.`)
            conversation.addMessage('user',
              `Your response didn't include a tool call or completion signal.\n` +
              `If you need to take action, use an XML tool block (e.g. <read_file><path>...</path></read_file>).\n` +
              `If the task is complete, signal completion:\n<attempt_completion>\n<result>\nYour answer here\n</result>\n</attempt_completion>`
            )
          }
          continue
        }

        // Last step — treat the response as the final answer
        const anySuccess = toolResults.some((t) => t.success)
        return this.buildToolResult(
          anySuccess ? 'success' : 'partial',
          parsed.textContent || response.content,
          anySuccess ? 0.7 : 0.5,
          totalTokensIn, totalTokensOut, model, startTime, artifacts
        )
      }

      // ── Loop detected or safety-valve hit ──
      const stopReason = loopDetected
        ? `Loop detected — you kept calling the same tool(s) repeatedly.`
        : `Safety limit reached (${ABSOLUTE_MAX_STEPS} steps).`

      const compactRecap = toolResults.slice(-10).map((t, i) => {
        const tName = t.tool.split('::').pop() ?? t.tool
        const firstLine = t.content.split('\n')[0].slice(0, 100)
        return `  ${i + 1}. ${tName} → ${t.success ? 'OK' : 'FAIL'}: ${firstLine}`
      }).join('\n')

      const summaryPrompt =
        `Original task: ${task.description}\n\n` +
        `${stopReason} Here's what happened (${toolResults.length} steps, last 10):\n` +
        compactRecap +
        `\n\nIMPORTANT: You have NO more tool calls. Do NOT output any tool calls.\n` +
        `Write a SHORT, DIRECT answer for the user (3-5 sentences max):\n` +
        `- What you found or accomplished\n` +
        `- What specific edit/fix is still needed (be precise)\n\n` +
        `CRITICAL: Do NOT ask the user questions. Be concise. State facts.`

      const summaryResponse = await this.think(summaryPrompt, context, {
        temperature: 0.3,
        maxTokens: modelConfig?.maxTokens,
        responseFormat: 'text',
      })
      totalTokensIn += summaryResponse.tokensIn
      totalTokensOut += summaryResponse.tokensOut

      let summaryText = summaryResponse.content
      // Strip any lingering tool-call JSON
      const toolCallMatch = summaryText.match(/\{\s*"tool"\s*:/)
      if (toolCallMatch && toolCallMatch.index !== undefined) {
        summaryText = summaryText.slice(0, toolCallMatch.index).trim()
        if (!summaryText) {
          summaryText = 'The task could not be fully completed within the available steps. Please try again or break it into smaller steps.'
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
      // Handle cancellation gracefully
      if (CancellationError.is(err) || (err instanceof Error && err.name === 'AbortError')) {
        console.log(`[${this.type}] Aborted (cancellation)`)
        const anySuccess = toolResults.some((t) => t.success)
        return this.buildToolResult(
          anySuccess ? 'partial' : 'failed',
          anySuccess ? 'Task cancelled. Partial results available.' : 'Task cancelled by user.',
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
   * Emit structured tool-call-info for the UI to render rich tool cards.
   * Called alongside agent:tool-result at every tool execution point.
   */
  protected emitToolCallInfo(opts: {
    taskId: string
    step: number
    tool: string
    args: Record<string, unknown>
    success: boolean
    summary: string
    duration?: number
    resultPreview?: string
  }): void {
    const toolName = opts.tool.split('::').pop() ?? opts.tool
    this.bus.emitEvent('agent:tool-call-info', {
      taskId: opts.taskId,
      agentType: this.type,
      step: opts.step,
      tool: opts.tool,
      toolName,
      args: opts.args,
      success: opts.success,
      summary: opts.summary,
      duration: opts.duration,
      resultPreview: opts.resultPreview,
    })
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

  // ─── Context Condensation (Phase 5) ─────────────────────

  /**
   * Perform LLM-powered conversation condensation.
   *
   * Takes old messages from the conversation, sends them to the LLM for
   * summarization, and replaces them with a concise summary + folded file
   * context (function/class signatures). This preserves semantic meaning
   * while freeing token budget for continued work.
   *
   * Falls back to the existing sliding-window trim if LLM call fails.
   */
  private async performCondensation(
    conversation: ConversationManager,
    context: AgentContext,
    fileRegistry: Map<string, FileRegistryEntry>,
    fileTracker: FileContextTracker,
  ): Promise<void> {
    const { toSummarize } = conversation.getMessagesToCondense(4)
    if (toSummarize.length < 3) return // not enough messages to condense

    // Generate folded file context from tracked files
    const foldedContext = this.buildFoldedFileContext(fileRegistry)

    // Build summarization prompt from messages to condense
    const messagesText = toSummarize.map(m =>
      `[${m.role.toUpperCase()}]: ${m.content.slice(0, 4000)}` // cap per message to avoid huge prompt
    ).join('\n\n---\n\n')

    const summaryPrompt =
      `Summarize the following conversation between an AI coding assistant and the tools it used. Preserve:\n` +
      `- All file paths mentioned and their relevance\n` +
      `- All code changes made (what was changed and why)\n` +
      `- Current task progress and remaining work\n` +
      `- Any errors encountered and how they were resolved\n` +
      `- Key decisions and their rationale\n\n` +
      `Be concise but thorough. DO NOT call any tools. Return ONLY a text summary.\n\n` +
      `--- CONVERSATION TO SUMMARIZE (${toSummarize.length} messages) ---\n\n${messagesText}`

    try {
      const adapter = LLMFactory.getForAgent(this.type)
      const modelConfig = LLMFactory.getAgentConfig(this.type)

      const response = await adapter.complete({
        model: modelConfig?.model,
        system: 'You are a precise conversation summarizer. Extract key facts, decisions, and progress concisely. Never call tools.',
        user: summaryPrompt,
        temperature: 0.1,
        maxTokens: 2000,
      })

      conversation.applyCondensation(response.content, foldedContext)

      const ctxAfter = conversation.getContextSummary()
      console.log(
        `[${this.type}] LLM condensation complete — ${toSummarize.length} messages summarized, ` +
        `context now at ${ctxAfter.usagePercent}% (${formatTokenCount(ctxAfter.tokensUsed)})`
      )

      this.bus.emitEvent('agent:acting', {
        agentType: this.type,
        taskId: context.taskId,
        action: `🗜️ Context condensed (${toSummarize.length} messages → summary, ${ctxAfter.usagePercent}% used)`,
      })
    } catch (err) {
      console.warn(`[${this.type}] LLM condensation failed, relying on auto-trim fallback:`, err)
      // The existing ConversationManager.trim() will handle overflow on next addMessage
    }
  }

  /**
   * Build folded file context from the file registry.
   *
   * Extracts function/class/type signatures from cached file contents
   * to preserve structural awareness after condensation. The LLM retains
   * knowledge of the codebase structure without needing full file contents.
   *
   * Regex-based extraction (no tree-sitter dependency).
   */
  private buildFoldedFileContext(fileRegistry: Map<string, FileRegistryEntry>): string {
    if (fileRegistry.size === 0) return ''

    const sections: string[] = []

    for (const [path, entry] of fileRegistry) {
      const lines = entry.content.split('\n')
      // Extract definition lines — function, class, interface, type, export signatures
      const sigLines = lines.filter(line =>
        /^\s*(export\s+)?(default\s+)?(abstract\s+)?(async\s+)?(function|class|interface|type|const|let|enum|def |struct |impl |trait |pub\s+(fn|struct|enum|trait))\s/.test(line)
      ).slice(0, 25) // cap at 25 definitions per file

      if (sigLines.length > 0) {
        const shortPath = path.replace(/\\/g, '/')
        sections.push(`<file-summary path="${shortPath}">\n${sigLines.join('\n')}\n</file-summary>`)
      }
    }

    // Cap total folded context at 30k chars
    return sections.join('\n').slice(0, 30_000)
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
