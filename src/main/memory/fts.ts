/**
 * Full-Text Search Service (FTS5)
 *
 * Wraps SQLite FTS5 virtual table for keyword-based memory search.
 * Indexes memory content with porter stemming + unicode support.
 */
import { getDatabase } from '../db/database'

// ─── Types ──────────────────────────────────────────────────

export interface FTSResult {
  memoryId: string
  memoryType: string
  content: string
  rank: number // FTS5 rank score (lower = better match)
}

// ─── FTS5 Search Service ────────────────────────────────────

export class FTSService {
  private db = getDatabase()

  /**
   * Index a memory for full-text search.
   * Inserts into the memory_fts virtual table.
   */
  index(memoryId: string, memoryType: string, content: string, tags?: string[]): void {
    // Build searchable text: content + tags
    const searchableText = tags?.length
      ? `${content} ${tags.join(' ')}`
      : content

    // Remove existing entry if present (FTS5 doesn't support ON CONFLICT)
    this.db.run(
      `DELETE FROM memory_fts WHERE memory_id = ? AND memory_type = ?`,
      memoryId,
      memoryType
    )

    this.db.run(
      `INSERT INTO memory_fts (memory_id, memory_type, content, tags)
       VALUES (?, ?, ?, ?)`,
      memoryId,
      memoryType,
      searchableText,
      tags?.join(' ') ?? ''
    )
  }

  /**
   * Remove a memory from the FTS index.
   */
  remove(memoryId: string, memoryType: string): void {
    this.db.run(
      `DELETE FROM memory_fts WHERE memory_id = ? AND memory_type = ?`,
      memoryId,
      memoryType
    )
  }

  /**
   * Search memories using FTS5 full-text search.
   * Supports standard FTS5 query syntax: AND, OR, NOT, "phrase", prefix*
   */
  search(query: string, options: { memoryType?: string; limit?: number } = {}): FTSResult[] {
    const { memoryType, limit = 20 } = options

    // Sanitize query for FTS5 — wrap in quotes if it contains special chars
    const sanitized = this.sanitizeQuery(query)

    if (!sanitized) return []

    try {
      if (memoryType) {
        return this.db.all<FTSResult>(
          `SELECT memory_id as memoryId, memory_type as memoryType, content, rank
           FROM memory_fts
           WHERE memory_fts MATCH ? AND memory_type = ?
           ORDER BY rank
           LIMIT ?`,
          sanitized,
          memoryType,
          limit
        )
      }

      return this.db.all<FTSResult>(
        `SELECT memory_id as memoryId, memory_type as memoryType, content, rank
         FROM memory_fts
         WHERE memory_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
        sanitized,
        limit
      )
    } catch (err) {
      // FTS5 match can throw if query syntax is invalid
      console.warn('[FTS] Search failed, trying simple query:', err)

      // Fallback: treat entire query as a simple term
      try {
        return this.db.all<FTSResult>(
          `SELECT memory_id as memoryId, memory_type as memoryType, content, rank
           FROM memory_fts
           WHERE memory_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
          `"${query.replace(/"/g, '')}"`,
          limit
        )
      } catch {
        return []
      }
    }
  }

  /**
   * Search with snippet highlighting.
   */
  searchWithSnippets(
    query: string,
    options: { memoryType?: string; limit?: number } = {}
  ): Array<FTSResult & { snippet: string }> {
    const { memoryType, limit = 20 } = options
    const sanitized = this.sanitizeQuery(query)
    if (!sanitized) return []

    try {
      const sql = memoryType
        ? `SELECT memory_id as memoryId, memory_type as memoryType, content, rank,
                  snippet(memory_fts, 2, '<b>', '</b>', '...', 32) as snippet
           FROM memory_fts
           WHERE memory_fts MATCH ? AND memory_type = ?
           ORDER BY rank LIMIT ?`
        : `SELECT memory_id as memoryId, memory_type as memoryType, content, rank,
                  snippet(memory_fts, 2, '<b>', '</b>', '...', 32) as snippet
           FROM memory_fts
           WHERE memory_fts MATCH ?
           ORDER BY rank LIMIT ?`

      const params = memoryType
        ? [sanitized, memoryType, limit]
        : [sanitized, limit]

      return this.db.all(sql, ...params)
    } catch {
      return []
    }
  }

  /** Get FTS index stats */
  getStats(): { totalIndexed: number; byType: Record<string, number> } {
    const total = this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM memory_fts`
    )?.count ?? 0

    // FTS5 tables don't support GROUP BY well, query the content table
    const byTypeRows = this.db.all<{ memory_type: string; count: number }>(
      `SELECT memory_type, COUNT(*) as count FROM memory_fts GROUP BY memory_type`
    )

    const byType: Record<string, number> = {}
    for (const row of byTypeRows) {
      byType[row.memory_type] = row.count
    }

    return { totalIndexed: total, byType }
  }

  // ─── Internal ─────────────────────────────────────────────

  /** Sanitize a user query for FTS5 safety */
  private sanitizeQuery(query: string): string {
    const trimmed = query.trim()
    if (!trimmed) return ''

    // If the query looks like plain text (no FTS operators), convert to prefix search
    if (!/[*"()]|AND|OR|NOT|NEAR/.test(trimmed)) {
      // Split into words, add prefix matching to each
      return trimmed
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .map((w) => `"${w.replace(/"/g, '')}"`)
        .join(' ')
    }

    return trimmed
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: FTSService | null = null

export function getFTSService(): FTSService {
  if (!instance) {
    instance = new FTSService()
  }
  return instance
}
