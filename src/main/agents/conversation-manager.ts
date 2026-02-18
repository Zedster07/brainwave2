/**
 * Conversation Manager — Multi-turn conversation history with token budgeting
 *
 * Manages the message array sent to the LLM. Handles:
 * - Appending user/assistant messages (flat string — legacy XML path)
 * - Structured content block messages (native tool calling path — M2.5/Claude)
 * - Token estimation per message
 * - Auto-trimming when context budget is exceeded (sliding window)
 * - Preserving the first message (task definition) and recent messages
 * - Formatting tool results as user messages
 *
 * Two message tracks:
 * - `messages` (ConversationMessage[]): Flat string messages, used by XML protocol
 * - `structuredMessages` (StructuredMessage[]): Content block messages for native tools
 *
 * When native tool calling is active, ONLY structuredMessages is used.
 * When XML protocol is active, ONLY messages is used (existing behavior).
 */
import type { ConversationMessage } from '../llm/types'
import type {
  StructuredMessage,
  ContentBlock,
  ToolResultBlock,
  ThinkingBlock,
} from '../llm/types'
import { extractTextFromBlocks, blocksToText } from '../llm/types'
import { countTokens } from '../llm/token-counter'

// ─── Tool Result Formatting ─────────────────────────────────

/** Maximum size for a single tool result before truncation (200KB) */
const MAX_TOOL_RESULT_LENGTH = 200_000

/**
 * Truncate tool result content if it exceeds the size limit.
 * Keeps the first and last half, with a truncation notice in the middle.
 */
function truncateToolResult(content: string, maxLength: number = MAX_TOOL_RESULT_LENGTH): string {
  if (content.length <= maxLength) return content
  const half = Math.floor(maxLength / 2)
  return (
    content.slice(0, half) +
    `\n\n[...${(content.length - maxLength).toLocaleString()} characters truncated...]\n\n` +
    content.slice(-half)
  )
}

/**
 * Format a tool result as a user message for the conversation.
 * Uses Cline-style XML formatting for clarity.
 * Automatically truncates large results to prevent context blowout.
 */
export function formatToolResult(
  toolName: string,
  success: boolean,
  content: string,
): string {
  const shortName = toolName.split('::').pop() ?? toolName
  const safeContent = truncateToolResult(content)
  return [
    `<tool_result>`,
    `<tool_name>${shortName}</tool_name>`,
    `<success>${success}</success>`,
    `<output>`,
    safeContent,
    `</output>`,
    `</tool_result>`,
  ].join('\n')
}

/**
 * Format multiple tool results into a single user message.
 * Used when the LLM response contained multiple XML tool blocks.
 */
export function formatMultipleToolResults(
  results: Array<{ tool: string; success: boolean; content: string }>,
): string {
  return results.map(r => formatToolResult(r.tool, r.success, r.content)).join('\n\n')
}

/**
 * Format an environment/system notice as a user message.
 * Used for compaction notices, context updates, warnings, etc.
 */
export function formatSystemNotice(notice: string): string {
  return `<system_notice>\n${notice}\n</system_notice>`
}

// ─── Conversation Manager ───────────────────────────────────

export class ConversationManager {
  private messages: ConversationMessage[] = []
  private tokenEstimates: number[] = [] // per-message token count
  private totalTokens = 0
  private trimCount = 0
  private llmCondensationCount = 0

  // ─── Structured Message Track (Native Tool Calling) ─────
  private structuredMsgs: StructuredMessage[] = []
  private structuredTokenEstimates: number[] = []
  private structuredTotalTokens = 0
  private _isNativeMode = false

  constructor(
    /** Maximum tokens for the entire conversation (input budget) */
    private maxTokenBudget: number = 80_000,
    /** Tokens reserved for the LLM's response (excluded from budget) */
    private reservedForResponse: number = 8_000,
  ) {}

  /** Whether this conversation is using native tool calling (structured messages) */
  get isNativeMode(): boolean {
    return this._isNativeMode
  }

  /** Enable native tool calling mode — switches to structured messages */
  enableNativeMode(): void {
    this._isNativeMode = true
  }

  // ─── Core API ───────────────────────────────────────────

  /** Add a message to the conversation */
  addMessage(role: 'user' | 'assistant', content: string): void {
    const tokens = countTokens(content)
    this.messages.push({ role, content })
    this.tokenEstimates.push(tokens)
    this.totalTokens += tokens

    // Auto-trim if over budget
    const budget = this.maxTokenBudget - this.reservedForResponse
    if (this.totalTokens > budget) {
      this.trim()
    }
  }

  /** Add a tool result as a user message */
  addToolResult(toolName: string, success: boolean, content: string): void {
    this.addMessage('user', formatToolResult(toolName, success, content))
  }

  /** Add multiple tool results as a single user message */
  addToolResults(results: Array<{ tool: string; success: boolean; content: string }>): void {
    this.addMessage('user', formatMultipleToolResults(results))
  }

  /** Add a system notice (compaction, context update, etc.) */
  addSystemNotice(notice: string): void {
    this.addMessage('user', formatSystemNotice(notice))
  }

  /** Get the current conversation as an immutable array */
  getMessages(): ConversationMessage[] {
    return [...this.messages]
  }

  /** Get total estimated tokens for the conversation */
  getTokenCount(): number {
    return this.totalTokens
  }

  /** Number of messages in the conversation */
  get length(): number {
    return this.messages.length
  }

  /** How many times the conversation has been trimmed */
  get trims(): number {
    return this.trimCount
  }

  /** Get the usage ratio (0.0 to 1.0+) */
  getUsageRatio(): number {
    const budget = this.maxTokenBudget - this.reservedForResponse
    return budget > 0 ? this.totalTokens / budget : 0
  }

  /** Check if the conversation is approaching the budget limit */
  isNearBudget(threshold = 0.85): boolean {
    return this.getUsageRatio() >= threshold
  }

  /** Update the token budget (e.g. when model changes) */
  setBudget(maxTokens: number, reserveForResponse = 8_000): void {
    this.maxTokenBudget = maxTokens
    this.reservedForResponse = reserveForResponse
    // Check if we need to trim with the new budget
    const budget = this.maxTokenBudget - this.reservedForResponse
    if (this.totalTokens > budget) {
      this.trim()
    }
  }

  /** Reset the conversation */
  clear(): void {
    this.messages = []
    this.tokenEstimates = []
    this.totalTokens = 0
    this.trimCount = 0
    this.llmCondensationCount = 0
    this.structuredMsgs = []
    this.structuredTokenEstimates = []
    this.structuredTotalTokens = 0
  }

  // ─── Structured Message API (Native Tool Calling) ───────

  /**
   * Add a structured message with content blocks.
   * Used by the native tool calling path (M2.5 / Claude).
   *
   * M2.5 CARDINAL RULE: For assistant messages, content MUST include
   * ALL blocks (thinking + text + tool_use) — never strip thinking blocks.
   */
  addStructuredMessage(role: 'user' | 'assistant', content: ContentBlock[]): void {
    const textForTokens = content
      .map(b => {
        switch (b.type) {
          case 'thinking': return b.thinking
          case 'text': return b.text
          case 'tool_use': return JSON.stringify(b.input)
          case 'tool_result': return typeof b.content === 'string' ? b.content : b.content.map(c => c.text).join('')
          default: return ''
        }
      })
      .join(' ')

    const tokens = countTokens(textForTokens)
    this.structuredMsgs.push({ role, content })
    this.structuredTokenEstimates.push(tokens)
    this.structuredTotalTokens += tokens

    // Also maintain the flat message track for backward compat / condensation
    const flatContent = blocksToText(content)
    this.addMessage(role, flatContent || '[structured content]')

    // Auto-trim structured messages if over budget
    const budget = this.maxTokenBudget - this.reservedForResponse
    if (this.structuredTotalTokens > budget) {
      this.trimStructured()
    }
  }

  /**
   * Add a user message containing tool_result blocks.
   * Used after executing tool calls from the assistant's response.
   *
   * Each tool_result MUST reference the tool_use_id from the assistant's
   * tool_use block, or M2.5 will reject the request.
   */
  addNativeToolResults(results: ToolResultBlock[]): void {
    this.addStructuredMessage('user', results)
  }

  /**
   * Add a text-only user message to the structured track.
   * Convenience wrapper for simple text messages.
   */
  addStructuredUserMessage(text: string): void {
    this.addStructuredMessage('user', [{ type: 'text', text }])
  }

  /**
   * Add a system notice to the structured track.
   * Wrapped in text block so it's compatible with the Anthropic API.
   */
  addStructuredNotice(notice: string): void {
    this.addStructuredUserMessage(`<system_notice>\n${notice}\n</system_notice>`)
  }

  /**
   * Get the structured conversation for the native tool calling API.
   * Returns a copy of the structured messages array.
   */
  getStructuredMessages(): StructuredMessage[] {
    return [...this.structuredMsgs]
  }

  /** Get total tokens for the structured track */
  getStructuredTokenCount(): number {
    return this.structuredTotalTokens
  }

  /** Check if structured track is near budget */
  isStructuredNearBudget(threshold = 0.85): boolean {
    const budget = this.maxTokenBudget - this.reservedForResponse
    return budget > 0 ? (this.structuredTotalTokens / budget) >= threshold : false
  }

  /** Get the usage ratio for the structured track (0.0 to 1.0+) */
  getStructuredUsageRatio(): number {
    const budget = this.maxTokenBudget - this.reservedForResponse
    return budget > 0 ? this.structuredTotalTokens / budget : 0
  }

  /**
   * Proactive compaction — called BEFORE we hit the hard trim threshold.
   *
   * Strategy (two-phase):
   * 1. Strip thinking blocks from all but the last 4 messages.
   *    Thinking is only useful for the most recent turns; old thinking
   *    wastes context rapidly (M2.5 can emit 10K+ thinking per turn).
   * 2. If still above the given ratio, drop middle messages (same
   *    approach as trimStructured but triggered earlier).
   *
   * Returns true if any compaction was performed.
   */
  proactiveCompact(targetRatio = 0.55): boolean {
    const budget = this.maxTokenBudget - this.reservedForResponse
    if (budget <= 0 || this.structuredMsgs.length <= 6) return false

    const beforeTokens = this.structuredTotalTokens
    let compacted = false

    // Phase 1: Strip thinking blocks from all but last 4 messages
    const thinkingCutoff = Math.max(0, this.structuredMsgs.length - 4)
    for (let i = 0; i < thinkingCutoff; i++) {
      const msg = this.structuredMsgs[i]
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const withoutThinking = msg.content.filter(b => b.type !== 'thinking')
        if (withoutThinking.length < msg.content.length) {
          msg.content = withoutThinking
          compacted = true
        }
      }
    }

    if (compacted) {
      // Recalculate token estimates after stripping thinking
      this.structuredTokenEstimates = this.structuredMsgs.map(msg => {
        const content = msg.content
        if (typeof content === 'string') return countTokens(content)
        return countTokens(content.map(b => {
          switch (b.type) {
            case 'thinking': return b.thinking
            case 'text': return b.text
            case 'tool_use': return JSON.stringify(b.input)
            case 'tool_result': return typeof b.content === 'string'
              ? b.content
              : b.content.map(c => c.text).join('')
            default: return ''
          }
        }).join(' '))
      })
      this.structuredTotalTokens = this.structuredTokenEstimates.reduce((a, b) => a + b, 0)
    }

    // Phase 2: If still above target ratio, drop middle messages
    const targetTokens = Math.floor(budget * targetRatio)
    if (this.structuredTotalTokens > targetTokens && this.structuredMsgs.length > 6) {
      const keepFirst = 1
      const keepLast = Math.min(8, Math.floor(this.structuredMsgs.length * 0.4))

      if (this.structuredMsgs.length > keepFirst + keepLast + 1) {
        const middleStart = keepFirst
        const middleEnd = this.structuredMsgs.length - keepLast

        let removedTokens = 0
        for (let i = middleStart; i < middleEnd; i++) {
          removedTokens += this.structuredTokenEstimates[i]
        }

        const condensedCount = middleEnd - middleStart
        const notice: StructuredMessage = {
          role: 'user',
          content: [{
            type: 'text',
            text: `[${condensedCount} earlier messages were proactively condensed at ` +
                  `${Math.round((this.structuredTotalTokens / budget) * 100)}% capacity. ` +
                  `The task definition and recent messages are preserved.]`,
          }],
        }
        const noticeTokens = countTokens('[condensed messages notice]')

        this.structuredMsgs.splice(middleStart, condensedCount, notice)
        this.structuredTokenEstimates.splice(middleStart, condensedCount, noticeTokens)
        this.structuredTotalTokens = this.structuredTotalTokens - removedTokens + noticeTokens
        this.trimCount++
        compacted = true
      }
    }

    if (compacted) {
      const saved = beforeTokens - this.structuredTotalTokens
      console.log(
        `[ConversationManager] Proactive compaction: ${beforeTokens} → ${this.structuredTotalTokens} tokens ` +
        `(saved ${saved}, ${this.structuredMsgs.length} msgs remaining)`
      )
    }

    return compacted
  }

  /**
   * Trim structured messages when over budget.
   *
   * Strategy: Similar to flat message trimming, but handles content blocks.
   * Special care: NEVER split an assistant message from its matching tool_result
   * user message — they must stay paired or M2.5 will error.
   *
   * Approach:
   * 1. Keep first message (task definition) and last N messages
   * 2. Replace middle with a condensed summary text block
   * 3. Strip thinking blocks from old messages (they're only needed for
   *    the most recent turn in practice)
   */
  private trimStructured(): void {
    const budget = this.maxTokenBudget - this.reservedForResponse
    if (this.structuredTotalTokens <= budget || this.structuredMsgs.length <= 6) return

    const keepFirst = 1 // task definition
    const keepLast = Math.min(8, Math.floor(this.structuredMsgs.length * 0.4))

    if (this.structuredMsgs.length <= keepFirst + keepLast + 1) return

    // First pass: strip thinking blocks from all but the last 4 messages
    // (M2.5 only needs thinking from the most recent assistant turn)
    const thinkingCutoff = Math.max(0, this.structuredMsgs.length - 4)
    for (let i = 0; i < thinkingCutoff; i++) {
      const msg = this.structuredMsgs[i]
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const withoutThinking = msg.content.filter(b => b.type !== 'thinking')
        if (withoutThinking.length < msg.content.length) {
          msg.content = withoutThinking
        }
      }
    }

    // Recalculate tokens after stripping thinking
    this.structuredTokenEstimates = this.structuredMsgs.map((msg, _i) => {
      const content = msg.content
      if (typeof content === 'string') return countTokens(content)
      return countTokens(content.map(b => {
        switch (b.type) {
          case 'thinking': return b.thinking
          case 'text': return b.text
          case 'tool_use': return JSON.stringify(b.input)
          case 'tool_result': return typeof b.content === 'string' ? b.content : b.content.map(c => c.text).join('')
          default: return ''
        }
      }).join(' '))
    })
    this.structuredTotalTokens = this.structuredTokenEstimates.reduce((a, b) => a + b, 0)

    // If still over budget, drop middle messages
    if (this.structuredTotalTokens > budget) {
      const middleStart = keepFirst
      const middleEnd = this.structuredMsgs.length - keepLast

      let removedTokens = 0
      for (let i = middleStart; i < middleEnd; i++) {
        removedTokens += this.structuredTokenEstimates[i]
      }

      const condensedCount = middleEnd - middleStart
      const notice: StructuredMessage = {
        role: 'user',
        content: [{
          type: 'text',
          text: `[${condensedCount} earlier messages were condensed to manage context limits. ` +
                `The task definition and recent messages are preserved.]`,
        }],
      }
      const noticeTokens = countTokens('[condensed messages notice]')

      this.structuredMsgs.splice(middleStart, condensedCount, notice)
      this.structuredTokenEstimates.splice(middleStart, condensedCount, noticeTokens)
      this.structuredTotalTokens = this.structuredTotalTokens - removedTokens + noticeTokens
      this.trimCount++

      // Recursive trim if still over
      if (this.structuredTotalTokens > budget && this.structuredMsgs.length > 6) {
        this.trimStructured()
      }
    }
  }

  // ─── LLM Condensation Support ───────────────────────────

  /** How many times the conversation has been condensed via LLM summarization */
  get condensations(): number {
    return this.llmCondensationCount
  }

  /**
   * Get messages that should be summarized and messages that should be kept.
   * Keeps the first message (task definition) and the last N messages.
   * Everything in between is returned as `toSummarize`.
   */
  getMessagesToCondense(keepRecent = 4): {
    toSummarize: ConversationMessage[]
    toKeep: ConversationMessage[]
  } {
    if (this.messages.length <= keepRecent + 2) {
      return { toSummarize: [], toKeep: [...this.messages] }
    }

    const toSummarize = this.messages.slice(1, -keepRecent)
    const toKeep = [this.messages[0], ...this.messages.slice(-keepRecent)]
    return { toSummarize, toKeep }
  }

  /**
   * Apply LLM-generated condensation to the conversation.
   * Replaces old messages with a summary + optional folded file context.
   * Keeps the first message (task definition) and recent messages.
   */
  applyCondensation(summary: string, foldedFileContext?: string): void {
    const keepRecent = 4
    if (this.messages.length <= keepRecent + 2) return

    const toKeep = [this.messages[0], ...this.messages.slice(-keepRecent)]

    // Build condensed content
    let condensedContent = `## Previous Conversation Summary\n${summary}`
    if (foldedFileContext) {
      condensedContent += `\n\n## File Structure Context\n${foldedFileContext}`
    }

    // Replace history: task definition + condensation summary + recent messages
    this.messages = [
      toKeep[0], // original task message
      { role: 'user' as const, content: formatSystemNotice(condensedContent) },
      ...toKeep.slice(1), // recent messages
    ]

    // Recalculate token counts
    this.tokenEstimates = this.messages.map(m => countTokens(m.content))
    this.totalTokens = this.tokenEstimates.reduce((a, b) => a + b, 0)
    this.llmCondensationCount++
  }

  // ─── Structured Track Condensation ─────────────────────

  /**
   * Get structured messages that should be summarized vs kept.
   * Splits the structured track: keeps first message (task def) + last N recent.
   * Everything in between is returned for summarization.
   */
  getStructuredMessagesToCondense(keepRecent = 4): {
    toSummarize: StructuredMessage[]
    toKeep: StructuredMessage[]
  } {
    if (this.structuredMsgs.length <= keepRecent + 2) {
      return { toSummarize: [], toKeep: [...this.structuredMsgs] }
    }

    const toSummarize = this.structuredMsgs.slice(1, -keepRecent)
    const toKeep = [this.structuredMsgs[0], ...this.structuredMsgs.slice(-keepRecent)]
    return { toSummarize, toKeep }
  }

  /**
   * Convert structured messages to plain text for summarization.
   * Extracts text, tool usage, tool results, and thinking into a readable format.
   * Strips thinking blocks from the summary input (they're verbose).
   */
  structuredMessagesToText(messages: StructuredMessage[]): string {
    return messages.map((msg, i) => {
      const role = msg.role.toUpperCase()
      const content = msg.content
      if (typeof content === 'string') return `[${role} #${i}]: ${content.slice(0, 4000)}`

      const parts: string[] = []
      for (const block of content) {
        switch (block.type) {
          case 'text':
            if (block.text.trim()) parts.push(block.text.slice(0, 3000))
            break
          case 'tool_use':
            parts.push(`[Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 500)})]`)
            break
          case 'tool_result': {
            const resultText = typeof block.content === 'string'
              ? block.content
              : block.content.map(c => c.text).join('')
            const status = block.is_error ? 'ERROR' : 'OK'
            parts.push(`[Result ${status}: ${resultText.slice(0, 1000)}]`)
            break
          }
          // Skip thinking blocks — too verbose for summaries
          default:
            break
        }
      }
      return `[${role} #${i}]: ${parts.join(' | ')}`
    }).join('\n\n---\n\n')
  }

  /**
   * Apply LLM-generated condensation to the structured track.
   * Replaces middle messages with a summary text block + optional folded context.
   * Also syncs the flat track.
   */
  applyStructuredCondensation(summary: string, foldedFileContext?: string): void {
    const keepRecent = 4
    if (this.structuredMsgs.length <= keepRecent + 2) return

    const toKeep = [this.structuredMsgs[0], ...this.structuredMsgs.slice(-keepRecent)]

    // Build condensed content
    let condensedContent = `## Previous Conversation Summary\n${summary}`
    if (foldedFileContext) {
      condensedContent += `\n\n## File Structure Context\n${foldedFileContext}`
    }

    // Replace structured history with: task def + summary + recent
    const summaryMsg: StructuredMessage = {
      role: 'user',
      content: [{
        type: 'text',
        text: `<system_notice>\n${condensedContent}\n</system_notice>`,
      }],
    }

    this.structuredMsgs = [
      toKeep[0],
      summaryMsg,
      ...toKeep.slice(1),
    ]

    // Recalculate structured token estimates
    this.structuredTokenEstimates = this.structuredMsgs.map(msg => {
      const content = msg.content
      if (typeof content === 'string') return countTokens(content)
      return countTokens(content.map(b => {
        switch (b.type) {
          case 'thinking': return b.thinking
          case 'text': return b.text
          case 'tool_use': return JSON.stringify(b.input)
          case 'tool_result': return typeof b.content === 'string'
            ? b.content
            : b.content.map(c => c.text).join('')
          default: return ''
        }
      }).join(' '))
    })
    this.structuredTotalTokens = this.structuredTokenEstimates.reduce((a, b) => a + b, 0)
    this.llmCondensationCount++

    // Also sync the flat track
    this.applyCondensation(summary, foldedFileContext)
    // Undo the double-increment from applyCondensation
    this.llmCondensationCount--
  }

  /**
   * Get a context summary object for environment details injection.
   * Used by the agent to report context usage in periodic updates.
   */
  getContextSummary(): {
    tokensUsed: number
    budgetTotal: number
    usagePercent: number
    messageCount: number
    condensations: number
    trims: number
  } {
    const budget = this.maxTokenBudget - this.reservedForResponse
    return {
      tokensUsed: this.totalTokens,
      budgetTotal: budget,
      usagePercent: Math.round(this.getUsageRatio() * 100),
      messageCount: this.messages.length,
      condensations: this.llmCondensationCount,
      trims: this.trimCount,
    }
  }

  // ─── Internal: Sliding-window trimming ──────────────────

  /**
   * Trim middle messages to fit within token budget.
   *
   * Strategy: Keep the first 2 messages (task definition + first response)
   * and the most recent messages. Replace the middle with a condensation
   * notice. This preserves:
   * - The task the agent is working on (always in message 0)
   * - The initial plan/response (message 1)
   * - The most recent tool calls and results (last N messages)
   */
  private trim(): void {
    const budget = this.maxTokenBudget - this.reservedForResponse
    if (this.totalTokens <= budget || this.messages.length <= 6) return

    const keepFirst = 2 // task definition + first response
    const keepLast = Math.min(8, Math.floor(this.messages.length * 0.4)) // at least 40% recent

    if (this.messages.length <= keepFirst + keepLast + 1) return

    const middleStart = keepFirst
    const middleEnd = this.messages.length - keepLast

    // Calculate tokens being removed
    let removedTokens = 0
    for (let i = middleStart; i < middleEnd; i++) {
      removedTokens += this.tokenEstimates[i]
    }

    // Build condensation notice
    const condensedCount = middleEnd - middleStart
    const notice = formatSystemNotice(
      `[${condensedCount} earlier messages were condensed to manage context limits. ` +
      `The task definition and recent messages are preserved. ` +
      `If you need to re-read a file, you may do so.]`
    )
    const noticeTokens = countTokens(notice)

    // Replace middle section with notice
    this.messages.splice(middleStart, condensedCount, { role: 'user', content: notice })
    this.tokenEstimates.splice(middleStart, condensedCount, noticeTokens)
    this.totalTokens = this.totalTokens - removedTokens + noticeTokens
    this.trimCount++

    // If still over budget after one trim, trim more aggressively
    if (this.totalTokens > budget && this.messages.length > 6) {
      this.trim()
    }
  }
}
