/**
 * Base Agent — Abstract class that all agents extend
 *
 * Provides the think → act → report cycle, confidence tracking,
 * LLM access, event bus integration, and memory context.
 */
import { randomUUID } from 'crypto'
import { LLMFactory } from '../llm'
import type { LLMRequest, LLMResponse, AgentModelConfig } from '../llm'
import { getEventBus, type AgentType } from './event-bus'
import { getDatabase } from '../db/database'
import { getSoftEngine } from '../rules'

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

export interface AgentContext {
  taskId: string
  planId?: string
  parentTask?: string
  relevantMemories?: string[]
  siblingResults?: Map<string, AgentResult>
}

export interface AgentResult {
  status: 'success' | 'partial' | 'failed'
  output: unknown
  confidence: number // 0.0 to 1.0
  reasoning?: string
  tokensIn: number
  tokensOut: number
  model: string
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
    }

    return adapter.complete(request)
  }

  /**
   * Think and expect JSON output.
   * Parses the JSON response automatically.
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

    const parsed = JSON.parse(response.content) as T
    return { parsed, raw: response }
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
  private logRun(task: SubTask, context: AgentContext, result: AgentResult): void {
    try {
      this.db.run(
        `INSERT INTO agent_runs (id, agent_type, task_id, status, input, output, llm_model, tokens_in, tokens_out, cost_usd, started_at, completed_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), CURRENT_TIMESTAMP, ?)`,
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
        `-${result.duration / 1000} seconds`,
        result.error ?? null
      )
    } catch (err) {
      console.error(`[${this.type}] Failed to log run:`, err)
    }
  }
}
