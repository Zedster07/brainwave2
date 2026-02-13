/**
 * Prospective Memory Store — Future intentions and reminders
 *
 * "What I need to do" — time-based reminders, event-triggered
 * intentions, and condition-based actions.
 */
import { randomUUID } from 'crypto'
import { getDatabase } from '../db/database'

// ─── Types ──────────────────────────────────────────────────

export type TriggerType = 'time' | 'event' | 'condition'
export type ProspectiveStatus = 'pending' | 'triggered' | 'completed' | 'expired'

export interface ProspectiveEntry {
  id: string
  intention: string
  triggerType: TriggerType
  triggerValue: string       // cron expression, event name, or condition description
  priority: number           // 0.0 to 1.0
  status: ProspectiveStatus
  createdAt: string
  dueAt: string | null
  completedAt: string | null
  tags: string[]
  metadata: Record<string, unknown>
}

export interface StoreProspectiveInput {
  intention: string
  triggerType: TriggerType
  triggerValue: string
  priority?: number
  dueAt?: string              // ISO date string
  tags?: string[]
  metadata?: Record<string, unknown>
}

// ─── Prospective Memory Store ───────────────────────────────

export class ProspectiveMemoryStore {
  private db = getDatabase()

  /** Store a new prospective memory (reminder/intention) */
  store(input: StoreProspectiveInput): ProspectiveEntry {
    const id = randomUUID()
    const now = new Date().toISOString()

    this.db.run(
      `INSERT INTO prospective_memories
        (id, intention, trigger_type, trigger_value, priority, status, created_at, due_at, completed_at, tags, metadata)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?)`,
      id,
      input.intention,
      input.triggerType,
      input.triggerValue,
      input.priority ?? 0.5,
      now,
      input.dueAt ?? null,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.metadata ?? {})
    )

    return {
      id,
      intention: input.intention,
      triggerType: input.triggerType,
      triggerValue: input.triggerValue,
      priority: input.priority ?? 0.5,
      status: 'pending',
      createdAt: now,
      dueAt: input.dueAt ?? null,
      completedAt: null,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
    }
  }

  /** Get by ID */
  getById(id: string): ProspectiveEntry | null {
    const row = this.db.get<RawRow>(`SELECT * FROM prospective_memories WHERE id = ?`, id)
    return row ? this.deserialize(row) : null
  }

  /** Get all pending prospective memories */
  getPending(limit = 50): ProspectiveEntry[] {
    const rows = this.db.all<RawRow>(
      `SELECT * FROM prospective_memories WHERE status = 'pending'
       ORDER BY priority DESC, due_at ASC LIMIT ?`,
      limit
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Get all prospective memories (any status) */
  getAll(limit = 100): ProspectiveEntry[] {
    const rows = this.db.all<RawRow>(
      `SELECT * FROM prospective_memories ORDER BY created_at DESC LIMIT ?`,
      limit
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Get due time-based reminders (past due and still pending) */
  getDue(): ProspectiveEntry[] {
    const now = new Date().toISOString()
    const rows = this.db.all<RawRow>(
      `SELECT * FROM prospective_memories
       WHERE trigger_type = 'time' AND status = 'pending' AND due_at <= ?
       ORDER BY priority DESC`,
      now
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Check for event-triggered memories that match an event name */
  checkEventTriggers(eventName: string): ProspectiveEntry[] {
    const pattern = `%${eventName}%`
    const rows = this.db.all<RawRow>(
      `SELECT * FROM prospective_memories
       WHERE trigger_type = 'event' AND status = 'pending' AND trigger_value LIKE ?`,
      pattern
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Mark a prospective memory as triggered */
  markTriggered(id: string): void {
    this.db.run(
      `UPDATE prospective_memories SET status = 'triggered' WHERE id = ? AND status = 'pending'`,
      id
    )
  }

  /** Mark as completed */
  markCompleted(id: string): void {
    this.db.run(
      `UPDATE prospective_memories SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      id
    )
  }

  /** Mark as expired */
  markExpired(id: string): void {
    this.db.run(
      `UPDATE prospective_memories SET status = 'expired' WHERE id = ?`,
      id
    )
  }

  /** Delete */
  delete(id: string): boolean {
    const result = this.db.run(`DELETE FROM prospective_memories WHERE id = ?`, id)
    return result.changes > 0
  }

  /** Count by status */
  count(status?: ProspectiveStatus): number {
    if (status) {
      const row = this.db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM prospective_memories WHERE status = ?`,
        status
      )
      return row?.count ?? 0
    }
    const row = this.db.get<{ count: number }>(`SELECT COUNT(*) as count FROM prospective_memories`)
    return row?.count ?? 0
  }

  // ─── Internal ─────────────────────────────────────────────

  private deserialize(row: RawRow): ProspectiveEntry {
    return {
      id: row.id,
      intention: row.intention,
      triggerType: row.trigger_type as TriggerType,
      triggerValue: row.trigger_value,
      priority: row.priority,
      status: row.status as ProspectiveStatus,
      createdAt: row.created_at,
      dueAt: row.due_at,
      completedAt: row.completed_at,
      tags: JSON.parse(row.tags || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
    }
  }
}

// ─── Raw DB Row ─────────────────────────────────────────────

interface RawRow {
  id: string
  intention: string
  trigger_type: string
  trigger_value: string
  priority: number
  status: string
  created_at: string
  due_at: string | null
  completed_at: string | null
  tags: string
  metadata: string
}

// ─── Singleton ──────────────────────────────────────────────

let instance: ProspectiveMemoryStore | null = null

export function getProspectiveStore(): ProspectiveMemoryStore {
  if (!instance) instance = new ProspectiveMemoryStore()
  return instance
}
