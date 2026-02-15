/**
 * Context Compactor — Progressive context size management
 *
 * When the agent's context approaches the model's limit, this module
 * progressively reduces context size while preserving critical information.
 *
 * Strategy (inspired by Goose's progressive compaction):
 *   Level 1: Compress action log — keep last N full, summarize older
 *   Level 2: Evict oldest files from registry (keep most recent ones)
 *   Level 3: Truncate remaining large files to key sections
 *
 * The compactor does NOT use LLM calls — all compaction is structural/heuristic
 * to avoid additional latency and cost. In the future, an LLM-based summary
 * could be added as a Level 4 nuclear option.
 */

import { countTokens } from '../llm/token-counter'

// ─── Types ──────────────────────────────────────────────────

export interface FileRegistryEntry {
  content: string
  step: number
  tokens?: number // cached token count
}

export interface ToolResultEntry {
  tool: string
  success: boolean
  content: string
}

export interface CompactionResult {
  /** New file registry after eviction */
  fileRegistry: Map<string, FileRegistryEntry>
  /** New tool results after compression */
  toolResults: ToolResultEntry[]
  /** Tokens freed by compaction */
  tokensFreed: number
  /** Compaction level applied (1-3) */
  levelApplied: number
  /** Human-readable summary of what was compacted */
  summary: string
}

// ─── Configuration ──────────────────────────────────────────

/** Number of recent action log entries to keep in full detail */
const KEEP_RECENT_ACTIONS = 6

/** Number of most-recently-read files to keep in the registry */
const KEEP_RECENT_FILES = 4

/** Maximum lines to keep from a truncated file */
const TRUNCATED_FILE_MAX_LINES = 100

/** Maximum tokens per file after truncation */
const MAX_TOKENS_PER_FILE = 3_000

// ─── Compaction Engine ──────────────────────────────────────

/**
 * Apply progressive compaction to reduce context size.
 *
 * @param fileRegistry - Current file registry (path → content+step)
 * @param toolResults  - Current tool results array
 * @param targetTokens - How many tokens we need to free (minimum)
 * @param currentStep  - Current step number (for identifying recent entries)
 * @returns CompactionResult with new registry and results
 */
export function compactContext(
  fileRegistry: Map<string, FileRegistryEntry>,
  toolResults: ToolResultEntry[],
  targetTokens: number,
  currentStep: number
): CompactionResult {
  let tokensFreed = 0
  let levelApplied = 0
  const summaryParts: string[] = []

  // Clone inputs so we don't mutate the originals
  const newFileRegistry = new Map(fileRegistry)
  let newToolResults = [...toolResults]

  // Pre-compute token counts for files if not cached
  for (const [path, entry] of newFileRegistry) {
    if (entry.tokens === undefined) {
      entry.tokens = countTokens(entry.content)
    }
  }

  // ── Level 1: Compress action log ──
  if (tokensFreed < targetTokens && newToolResults.length > KEEP_RECENT_ACTIONS) {
    levelApplied = 1
    const oldResults = newToolResults.slice(0, -KEEP_RECENT_ACTIONS)
    const recentResults = newToolResults.slice(-KEEP_RECENT_ACTIONS)

    // Calculate tokens in old entries
    const oldTokens = oldResults.reduce((sum, r) => sum + countTokens(r.content), 0)

    // Compress old entries to compact summaries
    const compressedOld = oldResults.map((r, i) => {
      const toolName = r.tool.split('::').pop() ?? r.tool
      const firstLine = r.content.split('\n')[0].slice(0, 80)
      return {
        tool: r.tool,
        success: r.success,
        content: `[Compacted] ${toolName}: ${r.success ? 'OK' : 'FAIL'} — ${firstLine}`,
      }
    })

    const newTokens = compressedOld.reduce((sum, r) => sum + countTokens(r.content), 0)
    tokensFreed += Math.max(0, oldTokens - newTokens)

    newToolResults = [...compressedOld, ...recentResults]
    summaryParts.push(`Compressed ${oldResults.length} old action log entries`)
  }

  // ── Level 2: Evict oldest files from registry ──
  if (tokensFreed < targetTokens && newFileRegistry.size > KEEP_RECENT_FILES) {
    levelApplied = 2

    // Sort files by step (oldest first)
    const sortedFiles = [...newFileRegistry.entries()]
      .sort((a, b) => a[1].step - b[1].step)

    const filesToEvict = sortedFiles.length - KEEP_RECENT_FILES
    const evictedPaths: string[] = []

    for (let i = 0; i < filesToEvict && tokensFreed < targetTokens; i++) {
      const [path, entry] = sortedFiles[i]
      const fileTokens = entry.tokens ?? countTokens(entry.content)
      tokensFreed += fileTokens
      evictedPaths.push(path)
      newFileRegistry.delete(path)
    }

    if (evictedPaths.length > 0) {
      summaryParts.push(`Evicted ${evictedPaths.length} oldest files: ${evictedPaths.map(p => p.split('/').pop()).join(', ')}`)
    }
  }

  // ── Level 3: Truncate remaining large files ──
  if (tokensFreed < targetTokens) {
    levelApplied = 3

    for (const [path, entry] of newFileRegistry) {
      const fileTokens = entry.tokens ?? countTokens(entry.content)

      if (fileTokens > MAX_TOKENS_PER_FILE) {
        const lines = entry.content.split('\n')

        if (lines.length > TRUNCATED_FILE_MAX_LINES) {
          // Keep first N/2 lines + last N/2 lines
          const halfMax = Math.floor(TRUNCATED_FILE_MAX_LINES / 2)
          const head = lines.slice(0, halfMax)
          const tail = lines.slice(-halfMax)
          const omitted = lines.length - TRUNCATED_FILE_MAX_LINES
          const truncated =
            head.join('\n') +
            `\n\n... [${omitted} lines omitted — file truncated to save context] ...\n\n` +
            tail.join('\n')

          const newTokens = countTokens(truncated)
          tokensFreed += fileTokens - newTokens
          entry.content = truncated
          entry.tokens = newTokens

          summaryParts.push(`Truncated ${path.split('/').pop()} (${lines.length} → ${TRUNCATED_FILE_MAX_LINES} lines)`)
        }
      }
    }
  }

  return {
    fileRegistry: newFileRegistry,
    toolResults: newToolResults,
    tokensFreed,
    levelApplied,
    summary: summaryParts.length > 0
      ? `Context compacted (level ${levelApplied}): ${summaryParts.join('; ')}`
      : 'No compaction needed',
  }
}

/**
 * Estimate the total tokens used by the file registry.
 */
export function estimateFileRegistryTokens(
  fileRegistry: Map<string, FileRegistryEntry>
): number {
  let total = 0
  for (const [path, entry] of fileRegistry) {
    // Path header + content
    total += countTokens(`--- ${path} (step ${entry.step}) ---\n`) + (entry.tokens ?? countTokens(entry.content))
  }
  return total
}

/**
 * Estimate the total tokens used by the action log.
 */
export function estimateActionLogTokens(
  toolResults: ToolResultEntry[]
): number {
  let total = 0
  for (const r of toolResults) {
    const toolName = r.tool.split('::').pop() ?? r.tool
    total += countTokens(`  ${toolName} → ${r.success ? 'OK' : 'FAIL'}: ${r.content.split('\n').slice(0, 3).join(' ').slice(0, 200)}`)
  }
  return total
}

/**
 * Build a compaction notice to inject into the prompt after compaction.
 * Similar to Goose's continuation messages.
 */
export function buildCompactionNotice(result: CompactionResult): string {
  if (result.tokensFreed === 0) return ''

  return (
    `\n== ⚠️ CONTEXT COMPACTED ==\n` +
    `${result.summary}\n` +
    `${result.tokensFreed.toLocaleString()} tokens freed.\n` +
    `Some earlier file contents or tool results may have been summarized.\n` +
    `Continue working naturally. Do not mention the compaction.\n`
  )
}
