/**
 * Multi Search/Replace Diff Strategy
 *
 * Cline/Roo Code-style diff engine that applies multiple SEARCH/REPLACE blocks
 * to a file in sequence. Each block specifies exact content to find and replace.
 *
 * Matching tiers (in order):
 *   1. Exact match
 *   2. Match at :start_line: hint (if provided) with fuzzy tolerance
 *   3. Whitespace-flexible (collapse spaces/tabs, trim line ends)
 *   4. Line-trimmed (trim() each line)
 *   5. Middle-out fuzzy with Levenshtein distance
 *
 * Features:
 *   - Multiple SEARCH/REPLACE blocks per call (batch edits)
 *   - Indentation preservation (adjusts replacement to match file indentation)
 *   - Proper Levenshtein edit distance (via fastest-levenshtein)
 *   - Stricter threshold (0.85 default vs old 0.75)
 *   - Detailed error reporting with best-match similarity
 */
import { distance } from 'fastest-levenshtein'

// ─── Types ──────────────────────────────────────────────────

export interface DiffBlock {
  /** The exact content to search for */
  searchContent: string
  /** The content to replace with */
  replaceContent: string
  /** Optional 1-based line number hint for faster matching */
  startLineHint?: number
}

export interface DiffResult {
  success: boolean
  /** The new file content after all blocks were applied */
  newContent: string
  /** Error message if any block failed */
  error?: string
  /** Number of blocks successfully applied */
  appliedCount: number
  /** Total blocks attempted */
  totalBlocks: number
  /** Details about each block's match tier */
  matchDetails: BlockMatchDetail[]
}

export interface BlockMatchDetail {
  blockIndex: number
  success: boolean
  matchTier?: string
  similarity?: number
  error?: string
  linesChanged?: { removed: number; added: number }
}

// ─── Main Strategy ──────────────────────────────────────────

export class MultiSearchReplaceDiffStrategy {
  private threshold: number

  constructor(threshold = 0.85) {
    this.threshold = threshold
  }

  /**
   * Apply multiple SEARCH/REPLACE diff blocks to file content sequentially.
   * Each block is applied to the result of the previous, so order matters.
   */
  applyDiff(originalContent: string, diffBlocks: DiffBlock[]): DiffResult {
    let content = originalContent
    const matchDetails: BlockMatchDetail[] = []
    let appliedCount = 0

    for (let i = 0; i < diffBlocks.length; i++) {
      const block = diffBlocks[i]
      const result = this.applySingleBlock(content, block, i)

      matchDetails.push(result.detail)

      if (!result.success) {
        return {
          success: false,
          newContent: content, // Return partially-applied content
          error: `Block ${i + 1}/${diffBlocks.length} failed: ${result.detail.error}`,
          appliedCount,
          totalBlocks: diffBlocks.length,
          matchDetails,
        }
      }

      content = result.newContent!
      appliedCount++
    }

    return {
      success: true,
      newContent: content,
      appliedCount,
      totalBlocks: diffBlocks.length,
      matchDetails,
    }
  }

  /**
   * Apply a single SEARCH/REPLACE block to content.
   */
  private applySingleBlock(
    content: string,
    block: DiffBlock,
    blockIndex: number
  ): { success: boolean; newContent?: string; detail: BlockMatchDetail } {
    const { searchContent, replaceContent, startLineHint } = block
    const contentLines = content.split('\n')
    const searchLines = searchContent.split('\n')

    // ── Tier 1: Exact match ──
    const exactCount = content.split(searchContent).length - 1
    if (exactCount === 1) {
      const newContent = content.replace(searchContent, replaceContent)
      return {
        success: true,
        newContent,
        detail: this.makeDetail(blockIndex, true, 'exact', 1.0, searchLines.length, replaceContent.split('\n').length),
      }
    }
    if (exactCount > 1) {
      return {
        success: false,
        detail: this.makeDetail(blockIndex, false, undefined, undefined, undefined, undefined,
          `Search content matches ${exactCount} locations. Add more context lines to make it unique.`),
      }
    }

    // ── Tier 2: Start-line hint match ──
    if (startLineHint !== undefined && startLineHint > 0) {
      const hintIndex = startLineHint - 1 // Convert 1-based to 0-based
      const bufferRange = 40 // Search ±40 lines around hint
      const startIdx = Math.max(0, hintIndex - bufferRange)
      const endIdx = Math.min(contentLines.length - searchLines.length, hintIndex + bufferRange)

      const fuzzyResult = this.fuzzySearchRange(searchLines, contentLines, startIdx, endIdx)
      if (fuzzyResult && fuzzyResult.similarity >= this.threshold) {
        const matched = contentLines.slice(fuzzyResult.index, fuzzyResult.index + searchLines.length)
        const adjustedReplace = this.adjustIndentation(searchLines, replaceContent.split('\n'), matched)
        const newContent = this.replaceLines(contentLines, fuzzyResult.index, searchLines.length, adjustedReplace)
        return {
          success: true,
          newContent,
          detail: this.makeDetail(blockIndex, true, `hint-fuzzy`, fuzzyResult.similarity, searchLines.length, adjustedReplace.length),
        }
      }
    }

    // ── Tier 3: Whitespace-flexible match ──
    const wsMatch = this.findWhitespaceFlexibleMatch(contentLines, searchLines)
    if (wsMatch !== null) {
      const matched = contentLines.slice(wsMatch, wsMatch + searchLines.length)
      const adjustedReplace = this.adjustIndentation(searchLines, replaceContent.split('\n'), matched)
      const newContent = this.replaceLines(contentLines, wsMatch, searchLines.length, adjustedReplace)
      return {
        success: true,
        newContent,
        detail: this.makeDetail(blockIndex, true, 'whitespace-flexible', 0.98, searchLines.length, adjustedReplace.length),
      }
    }

    // ── Tier 4: Line-trimmed match ──
    const trimMatch = this.findLineTrimmedMatch(contentLines, searchLines)
    if (trimMatch !== null) {
      const matched = contentLines.slice(trimMatch, trimMatch + searchLines.length)
      const adjustedReplace = this.adjustIndentation(searchLines, replaceContent.split('\n'), matched)
      const newContent = this.replaceLines(contentLines, trimMatch, searchLines.length, adjustedReplace)
      return {
        success: true,
        newContent,
        detail: this.makeDetail(blockIndex, true, 'line-trimmed', 0.95, searchLines.length, adjustedReplace.length),
      }
    }

    // ── Tier 5: Middle-out fuzzy with Levenshtein ──
    const fuzzyResult = this.fuzzySearchRange(searchLines, contentLines, 0, contentLines.length - searchLines.length)
    if (fuzzyResult && fuzzyResult.similarity >= this.threshold) {
      // Verify uniqueness — no other match within 90% of best
      const secondBest = this.findSecondBest(searchLines, contentLines, fuzzyResult.index)
      if (secondBest !== null && secondBest >= this.threshold && secondBest > 0.9 * fuzzyResult.similarity) {
        return {
          success: false,
          detail: this.makeDetail(blockIndex, false, undefined, fuzzyResult.similarity, undefined, undefined,
            `Fuzzy match is ambiguous — best=${(fuzzyResult.similarity * 100).toFixed(0)}%, second-best=${(secondBest * 100).toFixed(0)}%. Add more context for a unique match.`),
        }
      }

      const matched = contentLines.slice(fuzzyResult.index, fuzzyResult.index + searchLines.length)
      const adjustedReplace = this.adjustIndentation(searchLines, replaceContent.split('\n'), matched)
      const newContent = this.replaceLines(contentLines, fuzzyResult.index, searchLines.length, adjustedReplace)
      return {
        success: true,
        newContent,
        detail: this.makeDetail(blockIndex, true, `fuzzy-${(fuzzyResult.similarity * 100).toFixed(0)}%`, fuzzyResult.similarity, searchLines.length, adjustedReplace.length),
      }
    }

    // All tiers failed
    const bestSim = fuzzyResult?.similarity
    return {
      success: false,
      detail: this.makeDetail(blockIndex, false, undefined, bestSim, undefined, undefined,
        `Search content not found (tried exact, whitespace-flexible, line-trimmed, fuzzy). ` +
        `Best similarity: ${bestSim ? (bestSim * 100).toFixed(0) + '%' : 'N/A'}. ` +
        `File has ${contentLines.length} lines, search has ${searchLines.length} lines.`),
    }
  }

  // ─── Matching Algorithms ────────────────────────────────────

  /**
   * Whitespace-flexible: collapse runs of spaces/tabs, trim line endings.
   * Returns the 0-based line index of the match, or null.
   */
  private findWhitespaceFlexibleMatch(contentLines: string[], searchLines: string[]): number | null {
    const normalizeLine = (line: string) => line.replace(/[\t ]+/g, ' ').trimEnd()
    const normalizedSearch = searchLines.map(normalizeLine)

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let matches = true
      for (let j = 0; j < searchLines.length; j++) {
        if (normalizeLine(contentLines[i + j]) !== normalizedSearch[j]) {
          matches = false
          break
        }
      }
      if (matches) return i
    }
    return null
  }

  /**
   * Line-trimmed: trim() each line then compare.
   * Returns the 0-based line index of the match, or null.
   */
  private findLineTrimmedMatch(contentLines: string[], searchLines: string[]): number | null {
    const trimmedSearch = searchLines.map(l => l.trim())

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let matches = true
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[i + j].trim() !== trimmedSearch[j]) {
          matches = false
          break
        }
      }
      if (matches) return i
    }
    return null
  }

  /**
   * Middle-out fuzzy search using Levenshtein distance.
   * Searches from the midpoint of the range outward for a match.
   * Returns the best matching index and its similarity, or null.
   */
  private fuzzySearchRange(
    searchLines: string[],
    contentLines: string[],
    startIndex: number,
    endIndex: number
  ): { index: number; similarity: number } | null {
    if (searchLines.length > contentLines.length) return null
    if (endIndex < startIndex) return null

    const searchText = normalizeForFuzzy(searchLines.join('\n'))
    const midpoint = Math.floor((startIndex + endIndex) / 2)
    let bestMatch: { index: number; similarity: number } | null = null

    // Middle-out expansion from the midpoint
    const maxOffset = Math.max(midpoint - startIndex, endIndex - midpoint)
    for (let offset = 0; offset <= maxOffset; offset++) {
      const indices = offset === 0 ? [midpoint] : [midpoint + offset, midpoint - offset]

      for (const idx of indices) {
        if (idx < startIndex || idx + searchLines.length > contentLines.length) continue

        const chunk = contentLines.slice(idx, idx + searchLines.length).join('\n')
        const chunkNorm = normalizeForFuzzy(chunk)

        const dist = distance(searchText, chunkNorm)
        const maxLen = Math.max(searchText.length, chunkNorm.length)
        const similarity = maxLen > 0 ? 1 - dist / maxLen : 1

        if (similarity >= this.threshold && (!bestMatch || similarity > bestMatch.similarity)) {
          bestMatch = { index: idx, similarity }
          if (similarity === 1) return bestMatch // Exact match after normalization, stop early
        }
      }
    }

    return bestMatch
  }

  /**
   * Find the second-best fuzzy match similarity (excluding the best match area).
   * Used for ambiguity detection.
   */
  private findSecondBest(searchLines: string[], contentLines: string[], bestIndex: number): number | null {
    const searchText = normalizeForFuzzy(searchLines.join('\n'))
    let secondBest = 0

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      // Skip the area around the best match
      if (Math.abs(i - bestIndex) < searchLines.length) continue

      const chunk = contentLines.slice(i, i + searchLines.length).join('\n')
      const chunkNorm = normalizeForFuzzy(chunk)
      const dist = distance(searchText, chunkNorm)
      const maxLen = Math.max(searchText.length, chunkNorm.length)
      const sim = maxLen > 0 ? 1 - dist / maxLen : 1

      if (sim > secondBest) secondBest = sim
    }

    return secondBest > 0 ? secondBest : null
  }

  // ─── Indentation Preservation ─────────────────────────────

  /**
   * Adjust the indentation of replacement lines to match the file's indentation.
   *
   * If the file uses more indentation than the search block specified,
   * add the difference to each replacement line. If less, strip accordingly.
   */
  private adjustIndentation(
    searchLines: string[],
    replaceLines: string[],
    matchedLines: string[]
  ): string[] {
    if (searchLines.length === 0 || matchedLines.length === 0) return replaceLines

    const searchIndent = getLeadingWhitespace(searchLines[0])
    const matchIndent = getLeadingWhitespace(matchedLines[0])
    const indentDiff = matchIndent.length - searchIndent.length

    if (indentDiff === 0) return replaceLines

    return replaceLines.map(line => {
      if (line.trim() === '') return line // Don't adjust empty lines
      if (indentDiff > 0) {
        // File has more indentation — add spaces
        return ' '.repeat(indentDiff) + line
      } else {
        // File has less indentation — strip leading spaces (safely)
        const leading = getLeadingWhitespace(line)
        const strip = Math.min(-indentDiff, leading.length)
        return line.slice(strip)
      }
    })
  }

  // ─── Utility ──────────────────────────────────────────────

  /**
   * Replace a range of lines in the content and return the new full text.
   */
  private replaceLines(
    contentLines: string[],
    startIndex: number,
    removeCount: number,
    newLines: string[]
  ): string {
    const result = [...contentLines]
    result.splice(startIndex, removeCount, ...newLines)
    return result.join('\n')
  }

  private makeDetail(
    blockIndex: number,
    success: boolean,
    matchTier?: string,
    similarity?: number,
    removedLines?: number,
    addedLines?: number,
    error?: string
  ): BlockMatchDetail {
    return {
      blockIndex,
      success,
      matchTier,
      similarity,
      error,
      linesChanged: removedLines !== undefined && addedLines !== undefined
        ? { removed: removedLines, added: addedLines }
        : undefined,
    }
  }
}

// ─── Unified Diff Patch Parser ──────────────────────────────

/**
 * Parse a unified-diff-style patch for `apply_patch` tool.
 *
 * Format:
 *   *** Update File: path/to/file.ts
 *    unchanged context line
 *   -removed line
 *   +added line
 *    more context
 *
 *   *** Add File: path/to/new-file.ts
 *   +entire file content
 *   +line 2
 *
 *   *** Delete File: path/to/old-file.ts
 */
export interface PatchOperation {
  type: 'update' | 'add' | 'delete'
  path: string
  /** For 'update': the hunks to apply */
  hunks?: PatchHunk[]
  /** For 'add': the full file content */
  content?: string
}

export interface PatchHunk {
  /** Context + removed lines (what to match in the file) */
  contextLines: string[]
  /** Context + added lines (what to replace with) */
  replacementLines: string[]
}

/**
 * Parse the unified-diff-style patch from an `apply_patch` tool's <diff> parameter.
 */
export function parsePatchOperations(patchText: string): PatchOperation[] {
  const operations: PatchOperation[] = []
  const lines = patchText.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // *** Update File: path
    const updateMatch = line.match(/^\*\*\*\s+Update File:\s+(.+)$/)
    if (updateMatch) {
      const path = updateMatch[1].trim()
      i++
      const hunks = parseHunks(lines, i)
      i = hunks.endIndex
      operations.push({ type: 'update', path, hunks: hunks.hunks })
      continue
    }

    // *** Add File: path
    const addMatch = line.match(/^\*\*\*\s+Add File:\s+(.+)$/)
    if (addMatch) {
      const path = addMatch[1].trim()
      i++
      const contentLines: string[] = []
      while (i < lines.length && !lines[i].startsWith('***')) {
        const ln = lines[i]
        contentLines.push(ln.startsWith('+') ? ln.slice(1) : ln)
        i++
      }
      operations.push({ type: 'add', path, content: contentLines.join('\n') })
      continue
    }

    // *** Delete File: path
    const deleteMatch = line.match(/^\*\*\*\s+Delete File:\s+(.+)$/)
    if (deleteMatch) {
      operations.push({ type: 'delete', path: deleteMatch[1].trim() })
      i++
      continue
    }

    i++ // Skip unrecognized lines
  }

  return operations
}

/**
 * Parse diff hunks from lines starting at the given index.
 * Hunks are separated by blank lines. Context lines start with ' ',
 * removed lines with '-', added lines with '+'.
 */
function parseHunks(lines: string[], startIndex: number): { hunks: PatchHunk[]; endIndex: number } {
  const hunks: PatchHunk[] = []
  let i = startIndex
  let contextLines: string[] = []
  let replacementLines: string[] = []
  let inHunk = false

  while (i < lines.length && !lines[i].startsWith('***')) {
    const line = lines[i]

    if (line === '' && inHunk) {
      // Blank line ends a hunk
      if (contextLines.length > 0 || replacementLines.length > 0) {
        hunks.push({ contextLines: [...contextLines], replacementLines: [...replacementLines] })
        contextLines = []
        replacementLines = []
      }
      inHunk = false
      i++
      continue
    }

    if (line.startsWith(' ')) {
      // Context line — appears in both sides
      inHunk = true
      contextLines.push(line.slice(1))
      replacementLines.push(line.slice(1))
    } else if (line.startsWith('-')) {
      // Removed line — only in context (search) side
      inHunk = true
      contextLines.push(line.slice(1))
    } else if (line.startsWith('+')) {
      // Added line — only in replacement side
      inHunk = true
      replacementLines.push(line.slice(1))
    }

    i++
  }

  // Flush remaining hunk
  if (contextLines.length > 0 || replacementLines.length > 0) {
    hunks.push({ contextLines, replacementLines })
  }

  return { hunks, endIndex: i }
}

// ─── Helpers ────────────────────────────────────────────────

/** Normalize text for fuzzy comparison: lowercase, collapse whitespace */
function normalizeForFuzzy(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trimEnd())
    .join('\n')
    .toLowerCase()
}

/** Get the leading whitespace of a string */
function getLeadingWhitespace(line: string): string {
  const match = line.match(/^(\s*)/)
  return match ? match[1] : ''
}

// ─── Singleton ──────────────────────────────────────────────

let strategyInstance: MultiSearchReplaceDiffStrategy | null = null

export function getDiffStrategy(threshold?: number): MultiSearchReplaceDiffStrategy {
  if (!strategyInstance) {
    strategyInstance = new MultiSearchReplaceDiffStrategy(threshold)
  }
  return strategyInstance
}
