/**
 * Procedural Memory Store — Learned workflows and procedures
 *
 * "How to do things" — stores step-by-step procedures that emerged
 * from successful task completions. Tracks success rate and execution count.
 */
import { randomUUID } from 'crypto'
import { getDatabase } from '../db/database'

// ─── Types ──────────────────────────────────────────────────

export interface ProceduralStep {
  order: number
  action: string
  agent?: string
  expectedOutput?: string
  notes?: string
}

export interface ProceduralEntry {
  id: string
  name: string
  description: string | null
  steps: ProceduralStep[]
  triggerConditions: string[]
  successRate: number
  executionCount: number
  lastExecuted: string | null
  createdAt: string
  updatedAt: string
  tags: string[]
  metadata: Record<string, unknown>
}

export interface StoreProceduralInput {
  name: string
  description?: string
  steps: ProceduralStep[]
  triggerConditions?: string[]
  tags?: string[]
  metadata?: Record<string, unknown>
}

// ─── Procedural Memory Store ────────────────────────────────

export class ProceduralMemoryStore {
  private db = getDatabase()

  /** Store a new procedure */
  store(input: StoreProceduralInput): ProceduralEntry {
    const id = randomUUID()
    const now = new Date().toISOString()

    this.db.run(
      `INSERT INTO procedural_memories
        (id, name, description, steps, trigger_conditions, success_rate, execution_count, last_executed, created_at, updated_at, tags, metadata)
       VALUES (?, ?, ?, ?, ?, 0.0, 0, NULL, ?, ?, ?, ?)`,
      id,
      input.name,
      input.description ?? null,
      JSON.stringify(input.steps),
      JSON.stringify(input.triggerConditions ?? []),
      now,
      now,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.metadata ?? {})
    )

    return {
      id,
      name: input.name,
      description: input.description ?? null,
      steps: input.steps,
      triggerConditions: input.triggerConditions ?? [],
      successRate: 0,
      executionCount: 0,
      lastExecuted: null,
      createdAt: now,
      updatedAt: now,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
    }
  }

  /** Get a procedure by ID */
  getById(id: string): ProceduralEntry | null {
    const row = this.db.get<RawProceduralRow>(`SELECT * FROM procedural_memories WHERE id = ?`, id)
    return row ? this.deserialize(row) : null
  }

  /** Get all procedures ordered by success rate */
  getAll(limit = 50): ProceduralEntry[] {
    const rows = this.db.all<RawProceduralRow>(
      `SELECT * FROM procedural_memories ORDER BY success_rate DESC, execution_count DESC LIMIT ?`,
      limit
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Search by name or trigger conditions */
  search(query: string, limit = 20): ProceduralEntry[] {
    const pattern = `%${query}%`
    const rows = this.db.all<RawProceduralRow>(
      `SELECT * FROM procedural_memories
       WHERE name LIKE ? OR description LIKE ? OR trigger_conditions LIKE ? OR tags LIKE ?
       ORDER BY success_rate DESC LIMIT ?`,
      pattern,
      pattern,
      pattern,
      pattern,
      limit
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Find procedures matching a trigger condition */
  findByTrigger(triggerText: string): ProceduralEntry[] {
    const pattern = `%${triggerText}%`
    const rows = this.db.all<RawProceduralRow>(
      `SELECT * FROM procedural_memories WHERE trigger_conditions LIKE ? ORDER BY success_rate DESC`,
      pattern
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Record a procedure execution outcome */
  recordExecution(id: string, success: boolean): void {
    const entry = this.getById(id)
    if (!entry) return

    const newCount = entry.executionCount + 1
    // Running average of success rate
    const newRate = ((entry.successRate * entry.executionCount) + (success ? 1 : 0)) / newCount

    this.db.run(
      `UPDATE procedural_memories
       SET success_rate = ?, execution_count = ?, last_executed = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      Math.round(newRate * 1000) / 1000,
      newCount,
      id
    )
  }

  /** Update a procedure's steps */
  updateSteps(id: string, steps: ProceduralStep[]): ProceduralEntry | null {
    this.db.run(
      `UPDATE procedural_memories SET steps = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      JSON.stringify(steps),
      id
    )
    return this.getById(id)
  }

  /** Delete a procedure */
  delete(id: string): boolean {
    const result = this.db.run(`DELETE FROM procedural_memories WHERE id = ?`, id)
    return result.changes > 0
  }

  /** Count total procedures */
  count(): number {
    const row = this.db.get<{ count: number }>(`SELECT COUNT(*) as count FROM procedural_memories`)
    return row?.count ?? 0
  }

  // ─── Internal ─────────────────────────────────────────────

  private deserialize(row: RawProceduralRow): ProceduralEntry {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      steps: JSON.parse(row.steps || '[]'),
      triggerConditions: JSON.parse(row.trigger_conditions || '[]'),
      successRate: row.success_rate,
      executionCount: row.execution_count,
      lastExecuted: row.last_executed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tags: JSON.parse(row.tags || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
    }
  }
}

// ─── Raw DB Row ─────────────────────────────────────────────

interface RawProceduralRow {
  id: string
  name: string
  description: string | null
  steps: string
  trigger_conditions: string
  success_rate: number
  execution_count: number
  last_executed: string | null
  created_at: string
  updated_at: string
  tags: string
  metadata: string
}

// ─── Singleton ──────────────────────────────────────────────

let instance: ProceduralMemoryStore | null = null

export function getProceduralStore(): ProceduralMemoryStore {
  if (!instance) instance = new ProceduralMemoryStore()
  return instance
}
