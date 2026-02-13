/**
 * People Database — Knowledge graph of people
 *
 * Stores structured knowledge about people the user interacts with:
 * name, aliases, relationship, traits, preferences, interaction history.
 */
import { randomUUID } from 'crypto'
import { getDatabase } from '../db/database'

// ─── Types ──────────────────────────────────────────────────

export interface PersonEntry {
  id: string
  name: string
  relationship: string | null
  traits: string[]
  preferences: Record<string, string>
  interactionHistory: InteractionSummary[]
  lastInteraction: string | null
  createdAt: string
  updatedAt: string
  metadata: Record<string, unknown>
}

export interface InteractionSummary {
  date: string
  type: string          // 'meeting', 'email', 'task', 'mention', etc.
  summary: string
  sentiment?: number    // -1 to 1
}

export interface StorePersonInput {
  name: string
  relationship?: string
  traits?: string[]
  preferences?: Record<string, string>
  metadata?: Record<string, unknown>
}

export interface UpdatePersonInput {
  name?: string
  relationship?: string
  traits?: string[]
  preferences?: Record<string, string>
  metadata?: Record<string, unknown>
}

// ─── People Store ───────────────────────────────────────────

export class PeopleStore {
  private db = getDatabase()

  /** Create a new person (with alias-aware dedup) */
  store(input: StorePersonInput): PersonEntry {
    // Check for existing person with same name
    let existing = this.getByName(input.name)

    // If not found by name, check if any existing person has this name as a
    // nickname/alias in their preferences, or if the input has a nickname
    // that matches an existing person's name
    if (!existing) {
      existing = this.findByAlias(input.name)
    }
    if (!existing && input.preferences?.nickname) {
      existing = this.getByName(input.preferences.nickname) ?? this.findByAlias(input.preferences.nickname)
    }

    if (existing) {
      // Merge instead of duplicate
      return this.update(existing.id, {
        relationship: input.relationship ?? existing.relationship ?? undefined,
        traits: [...new Set([...existing.traits, ...(input.traits ?? [])])],
        preferences: { ...existing.preferences, ...(input.preferences ?? {}) },
        metadata: { ...existing.metadata, ...(input.metadata ?? {}) },
      }) ?? existing
    }

    const id = randomUUID()
    const now = new Date().toISOString()

    this.db.run(
      `INSERT INTO people
        (id, name, relationship, traits, preferences, interaction_history, last_interaction, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      id,
      input.name,
      input.relationship ?? null,
      JSON.stringify(input.traits ?? []),
      JSON.stringify(input.preferences ?? {}),
      JSON.stringify([]),
      now,
      now,
      JSON.stringify(input.metadata ?? {})
    )

    return {
      id,
      name: input.name,
      relationship: input.relationship ?? null,
      traits: input.traits ?? [],
      preferences: input.preferences ?? {},
      interactionHistory: [],
      lastInteraction: null,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {},
    }
  }

  /** Get a person by ID */
  getById(id: string): PersonEntry | null {
    const row = this.db.get<RawPersonRow>(`SELECT * FROM people WHERE id = ?`, id)
    return row ? this.deserialize(row) : null
  }

  /** Get a person by name (case-insensitive) */
  getByName(name: string): PersonEntry | null {
    const row = this.db.get<RawPersonRow>(
      `SELECT * FROM people WHERE LOWER(name) = LOWER(?)`,
      name
    )
    return row ? this.deserialize(row) : null
  }

  /** Get all people, ordered by last interaction */
  getAll(limit = 100): PersonEntry[] {
    const rows = this.db.all<RawPersonRow>(
      `SELECT * FROM people ORDER BY COALESCE(last_interaction, created_at) DESC LIMIT ?`,
      limit
    )
    return rows.map((r) => this.deserialize(r))
  }

  /**
   * Find a person by alias — checks nickname, full_name, and other alias fields
   * stored in the preferences JSON column.
   */
  findByAlias(alias: string): PersonEntry | null {
    const lowerAlias = alias.toLowerCase()
    // Search preferences JSON for nickname, full_name, or alias matches
    const rows = this.db.all<RawPersonRow>(
      `SELECT * FROM people WHERE
       LOWER(json_extract(preferences, '$.nickname')) = ? OR
       LOWER(json_extract(preferences, '$.full_name')) = ? OR
       LOWER(json_extract(preferences, '$.alias')) = ?`,
      lowerAlias, lowerAlias, lowerAlias
    )
    return rows.length > 0 ? this.deserialize(rows[0]) : null
  }

  /** Search people by name or traits */
  search(query: string, limit = 20): PersonEntry[] {
    const pattern = `%${query}%`
    const rows = this.db.all<RawPersonRow>(
      `SELECT * FROM people WHERE name LIKE ? OR relationship LIKE ? OR traits LIKE ?
       ORDER BY COALESCE(last_interaction, created_at) DESC LIMIT ?`,
      pattern,
      pattern,
      pattern,
      limit
    )
    return rows.map((r) => this.deserialize(r))
  }

  /** Update a person's details */
  update(id: string, input: UpdatePersonInput): PersonEntry | null {
    const existing = this.getById(id)
    if (!existing) return null

    const merged = {
      name: input.name ?? existing.name,
      relationship: input.relationship ?? existing.relationship,
      traits: input.traits ?? existing.traits,
      preferences: input.preferences ? { ...existing.preferences, ...input.preferences } : existing.preferences,
      metadata: input.metadata ? { ...existing.metadata, ...input.metadata } : existing.metadata,
    }

    this.db.run(
      `UPDATE people SET name = ?, relationship = ?, traits = ?, preferences = ?,
       metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      merged.name,
      merged.relationship,
      JSON.stringify(merged.traits),
      JSON.stringify(merged.preferences),
      JSON.stringify(merged.metadata),
      id
    )

    return this.getById(id)
  }

  /** Add an interaction to a person's history */
  addInteraction(id: string, interaction: InteractionSummary): PersonEntry | null {
    const person = this.getById(id)
    if (!person) return null

    const history = [...person.interactionHistory, interaction]
    // Keep last 50 interactions
    const trimmed = history.slice(-50)

    this.db.run(
      `UPDATE people SET interaction_history = ?, last_interaction = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      JSON.stringify(trimmed),
      interaction.date,
      id
    )

    return this.getById(id)
  }

  /** Delete a person */
  delete(id: string): boolean {
    const result = this.db.run(`DELETE FROM people WHERE id = ?`, id)
    return result.changes > 0
  }

  /** Count total people */
  count(): number {
    const row = this.db.get<{ count: number }>(`SELECT COUNT(*) as count FROM people`)
    return row?.count ?? 0
  }

  // ─── Internal ─────────────────────────────────────────────

  private deserialize(row: RawPersonRow): PersonEntry {
    return {
      id: row.id,
      name: row.name,
      relationship: row.relationship,
      traits: JSON.parse(row.traits || '[]'),
      preferences: JSON.parse(row.preferences || '{}'),
      interactionHistory: JSON.parse(row.interaction_history || '[]'),
      lastInteraction: row.last_interaction,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: JSON.parse(row.metadata || '{}'),
    }
  }
}

// ─── Raw DB Row ─────────────────────────────────────────────

interface RawPersonRow {
  id: string
  name: string
  relationship: string | null
  traits: string
  preferences: string
  interaction_history: string
  last_interaction: string | null
  created_at: string
  updated_at: string
  metadata: string
}

// ─── Singleton ──────────────────────────────────────────────

let instance: PeopleStore | null = null

export function getPeopleStore(): PeopleStore {
  if (!instance) instance = new PeopleStore()
  return instance
}
