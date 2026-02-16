/**
 * Tool Repetition Detector — Detects when the agent is stuck in a loop
 *
 * Phase 6: Error Recovery & Self-Correction
 *
 * Clean, standalone repetition detector inspired by Roo Code's approach.
 * Tracks consecutive identical tool calls using deterministic JSON serialization.
 * Designed to be used alongside the existing 3-strategy loop detection in base-agent.
 *
 * Also tracks per-file error counters for progressive fallback strategies:
 * - `diffErrors`: per-file diff/edit failure counts
 * - `editErrors`: per-file edit failure counts
 * - Counters drive the progressive diff fallback logic (suggest fewer blocks → exact text → full rewrite)
 */

// ─── Deterministic serialization ────────────────────────────

/**
 * Stable JSON serialization with sorted keys.
 * Ensures identical objects produce identical strings regardless of insertion order.
 */
function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null'
  if (typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`
  const sorted = Object.keys(obj as Record<string, unknown>).sort()
  const pairs = sorted.map(k => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`)
  return `{${pairs.join(',')}}`
}

// ─── Types ──────────────────────────────────────────────────

export interface RepetitionCheckResult {
  isRepetition: boolean
  count: number
}

export interface MistakeCounters {
  /** General validation/format errors */
  general: number
  /** Model responded without any tool call or completion signal */
  noToolUse: number
  /** Empty API responses */
  noAssistantMessage: number
  /** Per-file diff/edit failure counts */
  diffErrors: Map<string, number>
  /** Per-file write failure counts */
  editErrors: Map<string, number>
}

// ─── Tool Repetition Detector ───────────────────────────────

export class ToolRepetitionDetector {
  private previousToolCallJson: string | null = null
  private consecutiveIdenticalCount = 0
  private readonly limit: number

  constructor(limit = 3) {
    this.limit = limit
  }

  /**
   * Check if the given tool call is a repetition of the previous one.
   * Returns the consecutive count and whether the limit has been hit.
   */
  check(toolCall: { tool: string; args: Record<string, unknown> }): RepetitionCheckResult {
    const json = stableStringify({ tool: toolCall.tool, args: toolCall.args })

    if (this.previousToolCallJson === json) {
      this.consecutiveIdenticalCount++
    } else {
      this.consecutiveIdenticalCount = 0
    }

    this.previousToolCallJson = json

    return {
      isRepetition: this.consecutiveIdenticalCount >= this.limit,
      count: this.consecutiveIdenticalCount,
    }
  }

  /** Reset the detector (e.g. after a successful different tool call) */
  reset(): void {
    this.previousToolCallJson = null
    this.consecutiveIdenticalCount = 0
  }
}

// ─── Mistake Counters ───────────────────────────────────────

/**
 * Create a fresh set of mistake counters for a tool loop execution.
 */
export function createMistakeCounters(): MistakeCounters {
  return {
    general: 0,
    noToolUse: 0,
    noAssistantMessage: 0,
    diffErrors: new Map(),
    editErrors: new Map(),
  }
}

/**
 * Record a diff/edit error for a specific file path.
 * Returns the new error count for that file.
 */
export function recordFileError(
  counters: MistakeCounters,
  type: 'diff' | 'edit',
  filePath: string,
): number {
  const map = type === 'diff' ? counters.diffErrors : counters.editErrors
  const count = (map.get(filePath) ?? 0) + 1
  map.set(filePath, count)
  return count
}

/**
 * Get the error count for a specific file.
 */
export function getFileErrorCount(
  counters: MistakeCounters,
  type: 'diff' | 'edit',
  filePath: string,
): number {
  const map = type === 'diff' ? counters.diffErrors : counters.editErrors
  return map.get(filePath) ?? 0
}

// ─── Progressive Diff Fallback ──────────────────────────────

/** Grace retry threshold — how many noToolUse/noAssistantMessage before counting as general */
export const GRACE_RETRY_THRESHOLD = 2

/** Maximum general mistakes before forced termination */
export const MAX_GENERAL_MISTAKES = 5

/**
 * Generate a progressive feedback message for diff/edit failures.
 * The guidance escalates with each failure for the same file.
 *
 * @param filePath    - The file that failed
 * @param errorCount  - How many times edits to this file have failed
 * @param fileContent - Current file content to re-inject (truncated)
 * @returns Feedback message to inject into the conversation
 */
export function buildDiffFallbackMessage(
  filePath: string,
  errorCount: number,
  fileContent: string,
): string {
  const lines = fileContent.split('\n')
  const maxLines = 60
  const preview = lines.length > maxLines
    ? lines.slice(0, maxLines).join('\n') + `\n\n... [${lines.length - maxLines} more lines]`
    : fileContent

  if (errorCount <= 1) {
    // First failure: re-inject content, suggest fewer blocks
    return (
      `The edit to "${filePath}" failed. Here is the current file content:\n\n` +
      `\`\`\`\n${preview}\n\`\`\`\n\n` +
      `Try with fewer SEARCH/REPLACE blocks — ideally just one. ` +
      `Make sure your SEARCH text exactly matches text in the file, including whitespace and indentation.`
    )
  } else if (errorCount <= 3) {
    // 2nd-3rd failure: stronger guidance
    return (
      `Edit to "${filePath}" failed again (attempt ${errorCount}). Here is the current file content:\n\n` +
      `\`\`\`\n${preview}\n\`\`\`\n\n` +
      `IMPORTANT: Copy the EXACT text from the file above for the SEARCH section. ` +
      `Do not paraphrase or approximate — the match must be character-for-character identical. ` +
      `Include 3+ lines of surrounding context to make the match unique.`
    )
  } else {
    // 4th+ failure: suggest full file rewrite
    return (
      `Edit to "${filePath}" has failed ${errorCount} times. ` +
      `The diff approach is not working for this file. ` +
      `Use <write_to_file> to write the COMPLETE corrected file content instead of trying to edit it.`
    )
  }
}
