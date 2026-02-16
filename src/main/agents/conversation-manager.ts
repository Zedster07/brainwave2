/**
 * Conversation Manager — Multi-turn conversation history with token budgeting
 *
 * Manages the message array sent to the LLM. Handles:
 * - Appending user/assistant messages
 * - Token estimation per message
 * - Auto-trimming when context budget is exceeded (sliding window)
 * - Preserving the first message (task definition) and recent messages
 * - Formatting tool results as user messages
 */
import type { ConversationMessage } from '../llm/types'
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

  constructor(
    /** Maximum tokens for the entire conversation (input budget) */
    private maxTokenBudget: number = 80_000,
    /** Tokens reserved for the LLM's response (excluded from budget) */
    private reservedForResponse: number = 8_000,
  ) {}

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
