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
import { LLMFactory } from '../llm'
import type { LLMRequest, LLMResponse, ConversationMessage } from '../llm'
import type {
  Artifact,
} from './types'

// ─── Extracted modules ───
import { executeWithNativeTools } from './native-tool-runner'
import { executeWithTools as executeWithXmlTools } from './xml-tool-runner'
import { getEventBus, type AgentType } from './event-bus'
import { getDatabase } from '../db/database'
import { getSoftEngine } from '../rules'
import { getPromptRegistry } from '../prompts'
import { calculateCost } from '../llm/pricing'
import { countTokens } from '../llm/token-counter'
import { type ApprovalSettings, getDefaultApprovalSettings } from '../tools/approval'
import { getMcpRegistry } from '../mcp'
import { getLocalToolProvider } from '../tools'
import { getModeRegistry } from '../modes'
import { hasToolAccess, getAgentPermissions, filterToolsForAgent, filterToolsForMode } from '../tools/permissions'
import { registerToolName } from './xml-parser'
import { buildDelegationToolDescription, buildParallelDelegationToolDescription } from './delegation'

// ─── Types (re-exported from ./types for backward compatibility) ───
export type { SubTask, TaskPlan, ToolingNeeds, AgentContext, AgentResult, SuggestedMemory, Artifact, BaseAgentHandle } from './types'
import type { SubTask, AgentContext, AgentResult, BaseAgentHandle } from './types'

// ─── Base Agent ──────────────────────────────────────────────

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

  // ════════════════════════════════════════════════════════════════════════
  //  AGENTIC TOOL LOOP — Shared infrastructure for all agents
  // ════════════════════════════════════════════════════════════════════════

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

  // ════════════════════════════════════════════════════════════════════════
  // ══ NATIVE TOOL CALLING LOOP (M2.5 / Anthropic SDK) ═════════════════════
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Execute a task using NATIVE tool calling (Anthropic SDK format).
   * Delegates to the extracted native-tool-runner module.
   */
  protected async executeWithNativeTools(
    task: SubTask,
    context: AgentContext,
  ): Promise<AgentResult> {
    return executeWithNativeTools(this, task, context)
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
   * Delegates to the extracted xml-tool-runner module.
   */
  protected async executeWithTools(
    task: SubTask,
    context: AgentContext
  ): Promise<AgentResult> {
    return executeWithXmlTools(this, task, context)
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
