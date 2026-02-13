/**
 * Episodic Memory Store — Time-stamped records of past experiences
 *
 * "What happened" — stores task outcomes, lessons learned, decisions,
 * and tracks strength decay over time.
 */
import { randomUUID } from 'crypto'
import { getDatabase } from '../db/database'

// ─── Types ──────────────────────────────────────────────────

export interface EpisodicEntry {
  id: string
  content: string
  context: Record<string, unknown>  // task_id, agent_id, trigger, etc.
  emotionalValence: number          // -1.0 (bad) to +1.0 (good)
  importance: number                // 0.0 to 1.0
  timestamp: string
  lastAccessed: string
  accessCount: number
  decayRate: number
  tags: string[]
  metadata: Record<string, unknown>
}

export interface StoreEpisodicInput {
  content: string
  context?: Record<string, unknown>
  emotionalValence?: number
  importance?: number
  tags?: string[]
  metadata?: Record<string, unknown>
}

// ─── Episodic Memory Store ──────────────────────────────────

export class EpisodicMemoryStore {
  private db = getDatabase()

  /** Store a new episodic memory */
  store(input: StoreEpisodicInput): EpisodicEntry {
    const id = randomUUID()
    const now = new Date().toISOString()

    // Emotional memories get lower decay rates (persist longer)
    const emotionalValence = input.emotionalValence ?? 0
    const decayRate = this.calculateInitialDecayRate(emotionalValence, input.importance ?? 0.5)

    this.db.run(
      `INSERT INTO episodic_memories
        (id, content, context, emotional_valence, importance, timestamp, last_accessed, access_count, decay_rate, tags, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      id,
      input.content,
      JSON.stringify(input.context ?? {}),
      emotionalValence,
      input.importance ?? 0.5,
      now,
      now,
      decayRate,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.metadata ?? {})
    )

    return {
      id,
      content: input.content,
      context: input.context ?? {},
      emotionalValence,
      importance: input.importance ?? 0.5,
      timestamp: now,
      lastAccessed: now,
      accessCount: 0,
      decayRate,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
    }
  }

  /** Retrieve an episodic memory by ID and touch it (strengthens) */
  recall(id: string): EpisodicEntry | null {
    const row = this.db.get<RawEpisodicRow>(
      `SELECT * FROM episodic_memories WHERE id = ?`,
      id
    )
    if (!row) return null

    // Touch — increment access count and update last_accessed
    this.touch(id)

    return this.deserialize(row)
  }

  /** Search episodic memories by recency */
  getRecent(limit = 20): EpisodicEntry[] {
    const rows = this.db.all<RawEpisodicRow>(
      `SELECT * FROM episodic_memories ORDER BY timestamp DESC LIMIT ?`,
      limit
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Search by importance (above threshold) */
  getImportant(minImportance = 0.7, limit = 20): EpisodicEntry[] {
    const rows = this.db.all<RawEpisodicRow>(
      `SELECT * FROM episodic_memories WHERE importance >= ? ORDER BY importance DESC LIMIT ?`,
      minImportance,
      limit
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Search by tags */
  getByTags(tags: string[], limit = 20): EpisodicEntry[] {
    // SQLite JSON — check if any provided tag exists in the tags array
    const conditions = tags.map(() => `tags LIKE ?`).join(' OR ')
    const params = tags.map((t) => `%"${t}"%`)
    const rows = this.db.all<RawEpisodicRow>(
      `SELECT * FROM episodic_memories WHERE (${conditions}) ORDER BY timestamp DESC LIMIT ?`,
      ...params,
      limit
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Get all episodic memories (for decay processing) */
  getAll(): EpisodicEntry[] {
    const rows = this.db.all<RawEpisodicRow>(`SELECT * FROM episodic_memories`)
    return rows.map((r) => this.deserialize(r))
  }

  /** Update importance (used during decay / consolidation) */
  updateImportance(id: string, importance: number): void {
    this.db.run(
      `UPDATE episodic_memories SET importance = ? WHERE id = ?`,
      Math.max(0, Math.min(1, importance)),
      id
    )
  }

  /** Delete an episodic memory */
  delete(id: string): boolean {
    const result = this.db.run(`DELETE FROM episodic_memories WHERE id = ?`, id)
    return result.changes > 0
  }

  /** Count total episodic memories */
  count(): number {
    const row = this.db.get<{ count: number }>(`SELECT COUNT(*) as count FROM episodic_memories`)
    return row?.count ?? 0
  }

  // ─── Internal ─────────────────────────────────────────────

  /** Touch — strengthens memory by incrementing access count */
  private touch(id: string): void {
    this.db.run(
      `UPDATE episodic_memories SET access_count = access_count + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = ?`,
      id
    )
  }

  /** Calculate initial decay rate based on emotional intensity and importance */
  private calculateInitialDecayRate(emotionalValence: number, importance: number): number {
    let rate = 0.1 // Base decay rate

    // Emotional memories decay slower
    rate *= 1 - Math.abs(emotionalValence) * 0.5

    // Important memories decay slower
    rate *= 1 - importance * 0.3

    return Math.max(0.01, rate)
  }

  /** Deserialize a raw DB row into an EpisodicEntry */
  private deserialize(row: RawEpisodicRow): EpisodicEntry {
    return {
      id: row.id,
      content: row.content,
      context: JSON.parse(row.context || '{}'),
      emotionalValence: row.emotional_valence,
      importance: row.importance,
      timestamp: row.timestamp,
      lastAccessed: row.last_accessed,
      accessCount: row.access_count,
      decayRate: row.decay_rate,
      tags: JSON.parse(row.tags || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
    }
  }
}

// ─── Raw DB row type ────────────────────────────────────────

interface RawEpisodicRow {
  id: string
  content: string
  context: string
  emotional_valence: number
  importance: number
  timestamp: string
  last_accessed: string
  access_count: number
  decay_rate: number
  tags: string
  metadata: string
}
