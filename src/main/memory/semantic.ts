/**
 * Semantic Memory Store — Facts, knowledge, and learned concepts
 *
 * "What I know" — context-free truths like user preferences,
 * coding rules, factual knowledge, and definitions.
 */
import { randomUUID } from 'crypto'
import { getDatabase } from '../db/database'

// ─── Types ──────────────────────────────────────────────────

export type SemanticCategory = 'preference' | 'fact' | 'rule' | 'definition' | 'opinion'

export interface SemanticEntry {
  id: string
  subject: string
  predicate: string
  object: string
  confidence: number                // 0.0 to 1.0
  source: string | null
  createdAt: string
  updatedAt: string
  accessCount: number
  tags: string[]
  metadata: Record<string, unknown>
}

export interface StoreSemanticInput {
  subject: string
  predicate: string
  object: string
  confidence?: number
  source?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

// ─── Semantic Memory Store ──────────────────────────────────

export class SemanticMemoryStore {
  private db = getDatabase()

  /** Store a new semantic memory (or update if duplicate subject+predicate exists) */
  store(input: StoreSemanticInput): SemanticEntry {
    // Check for existing knowledge with same subject+predicate
    const existing = this.db.get<RawSemanticRow>(
      `SELECT * FROM semantic_memories WHERE subject = ? AND predicate = ?`,
      input.subject,
      input.predicate
    )

    if (existing) {
      // Update existing — keep higher confidence version
      const newConfidence = Math.max(existing.confidence, input.confidence ?? 0.5)
      this.db.run(
        `UPDATE semantic_memories
         SET object = ?, confidence = ?, source = COALESCE(?, source),
             tags = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        input.object,
        newConfidence,
        input.source ?? null,
        JSON.stringify(input.tags ?? JSON.parse(existing.tags || '[]')),
        JSON.stringify(input.metadata ?? JSON.parse(existing.metadata || '{}')),
        existing.id
      )

      return {
        id: existing.id,
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        confidence: newConfidence,
        source: input.source ?? existing.source,
        createdAt: existing.created_at,
        updatedAt: new Date().toISOString(),
        accessCount: existing.access_count,
        tags: input.tags ?? JSON.parse(existing.tags || '[]'),
        metadata: input.metadata ?? JSON.parse(existing.metadata || '{}'),
      }
    }

    // New entry
    const id = randomUUID()
    const now = new Date().toISOString()

    this.db.run(
      `INSERT INTO semantic_memories
        (id, subject, predicate, object, confidence, source, created_at, updated_at, access_count, tags, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      id,
      input.subject,
      input.predicate,
      input.object,
      input.confidence ?? 0.5,
      input.source ?? null,
      now,
      now,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.metadata ?? {})
    )

    return {
      id,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      confidence: input.confidence ?? 0.5,
      source: input.source ?? null,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
    }
  }

  /** Recall a semantic memory by ID and touch it */
  recall(id: string): SemanticEntry | null {
    const row = this.db.get<RawSemanticRow>(
      `SELECT * FROM semantic_memories WHERE id = ?`,
      id
    )
    if (!row) return null
    this.touch(id)
    return this.deserialize(row)
  }

  /** Search by subject */
  getBySubject(subject: string, limit = 20): SemanticEntry[] {
    const rows = this.db.all<RawSemanticRow>(
      `SELECT * FROM semantic_memories WHERE subject = ? ORDER BY confidence DESC LIMIT ?`,
      subject,
      limit
    )
    rows.forEach((r) => this.touch(r.id))
    return rows.map((r) => this.deserialize(r))
  }

  /** Search by predicate (e.g., "prefers", "uses", "dislikes") */
  getByPredicate(predicate: string, limit = 20): SemanticEntry[] {
    const rows = this.db.all<RawSemanticRow>(
      `SELECT * FROM semantic_memories WHERE predicate = ? ORDER BY confidence DESC LIMIT ?`,
      predicate,
      limit
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Get high-confidence facts */
  getHighConfidence(minConfidence = 0.8, limit = 50): SemanticEntry[] {
    const rows = this.db.all<RawSemanticRow>(
      `SELECT * FROM semantic_memories WHERE confidence >= ? ORDER BY confidence DESC LIMIT ?`,
      minConfidence,
      limit
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Search by tags */
  getByTags(tags: string[], limit = 20): SemanticEntry[] {
    const conditions = tags.map(() => `tags LIKE ?`).join(' OR ')
    const params = tags.map((t) => `%"${t}"%`)
    const rows = this.db.all<RawSemanticRow>(
      `SELECT * FROM semantic_memories WHERE (${conditions}) ORDER BY confidence DESC LIMIT ?`,
      ...params,
      limit
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Get all semantic memories */
  getAll(): SemanticEntry[] {
    const rows = this.db.all<RawSemanticRow>(`SELECT * FROM semantic_memories`)
    return rows.map((r) => this.deserialize(r))
  }

  /** Update confidence for a memory */
  updateConfidence(id: string, confidence: number): void {
    this.db.run(
      `UPDATE semantic_memories SET confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      Math.max(0, Math.min(1, confidence)),
      id
    )
  }

  /** Delete a semantic memory */
  delete(id: string): boolean {
    const result = this.db.run(`DELETE FROM semantic_memories WHERE id = ?`, id)
    return result.changes > 0
  }

  /** Count total semantic memories */
  count(): number {
    const row = this.db.get<{ count: number }>(`SELECT COUNT(*) as count FROM semantic_memories`)
    return row?.count ?? 0
  }

  // ─── Internal ─────────────────────────────────────────────

  private touch(id: string): void {
    this.db.run(
      `UPDATE semantic_memories SET access_count = access_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      id
    )
  }

  private deserialize(row: RawSemanticRow): SemanticEntry {
    return {
      id: row.id,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      confidence: row.confidence,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accessCount: row.access_count,
      tags: JSON.parse(row.tags || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
    }
  }
}

// ─── Raw DB row type ────────────────────────────────────────

interface RawSemanticRow {
  id: string
  subject: string
  predicate: string
  object: string
  confidence: number
  source: string | null
  created_at: string
  updated_at: string
  access_count: number
  tags: string
  metadata: string
}
