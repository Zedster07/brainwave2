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
   * Pass '*' to retrieve all indexed memories (no MATCH filter).
   */
  search(query: string, options: { memoryType?: string; limit?: number } = {}): FTSResult[] {
    const { memoryType, limit = 20 } = options
    const trimmed = query.trim()

    // Wildcard / get-all: return rows without FTS MATCH
    if (trimmed === '*' || !trimmed) {
      return this.getAll(memoryType, limit)
    }

    // Sanitize query for FTS5 safety
    const sanitized = this.sanitizeQuery(trimmed)
    if (!sanitized) return this.getAll(memoryType, limit)

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

      // Fallback: treat entire query as a simple term (strip everything except alphanumeric)
      const fallbackTerm = trimmed.replace(/[^a-zA-Z0-9\s]/g, '').trim()
      if (!fallbackTerm) return this.getAll(memoryType, limit)

      try {
        return this.db.all<FTSResult>(
          `SELECT memory_id as memoryId, memory_type as memoryType, content, rank
           FROM memory_fts
           WHERE memory_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
          `"${fallbackTerm}"`,
          limit
        )
      } catch {
        return []
      }
    }
  }

  /** Return rows without FTS MATCH (for wildcard / browse queries) */
  private getAll(memoryType?: string, limit = 20): FTSResult[] {
    if (memoryType) {
      return this.db.all<FTSResult>(
        `SELECT memory_id as memoryId, memory_type as memoryType, content, 0 as rank
         FROM memory_fts
         WHERE memory_type = ?
         ORDER BY rowid DESC
         LIMIT ?`,
        memoryType,
        limit
      )
    }
    return this.db.all<FTSResult>(
      `SELECT memory_id as memoryId, memory_type as memoryType, content, 0 as rank
       FROM memory_fts
       ORDER BY rowid DESC
       LIMIT ?`,
      limit
    )
  }

  /**
   * Search with snippet highlighting.
   */
  searchWithSnippets(
    query: string,
    options: { memoryType?: string; limit?: number } = {}
  ): Array<FTSResult & { snippet: string }> {
    const { memoryType, limit = 20 } = options
    const trimmed = query.trim()

    // Wildcard / empty — snippets don't apply, return content as-is
    if (trimmed === '*' || !trimmed) {
      return this.getAll(memoryType, limit).map((r) => ({ ...r, snippet: r.content.slice(0, 200) }))
    }

    const sanitized = this.sanitizeQuery(trimmed)
    if (!sanitized) {
      return this.getAll(memoryType, limit).map((r) => ({ ...r, snippet: r.content.slice(0, 200) }))
    }

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
    // Strip FTS5 special characters and operators, keep only real words
    const words = query
      .replace(/[*"(){}[\]:^~]/g, '') // Remove special FTS chars
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '') // Remove FTS operators
      .split(/\s+/)
      .filter((w) => w.length > 0)

    if (words.length === 0) return ''

    // Wrap each word in quotes for safe phrase matching
    return words.map((w) => `"${w}"`).join(' ')
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
