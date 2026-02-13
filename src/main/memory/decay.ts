/**
 * Memory Decay & Consolidation Service
 *
 * Implements Ebbinghaus forgetting curve for episodic memories:
 *   retention = e^(-t / S)
 *   where t = time since last access, S = stability (inverse decay rate)
 *
 * Consolidation: high-importance episodic memories that survive long enough
 * get promoted to semantic memories (facts extracted from experience).
 *
 * Garbage collection: memories whose effective importance drops below a
 * threshold get pruned to keep the store lean.
 */
import { getDatabase } from '../db/database'
import { getEventBus } from '../agents/event-bus'
import type { EpisodicEntry } from './episodic'

// ─── Config ─────────────────────────────────────────────────

export interface DecayConfig {
  /** Run decay every N milliseconds (default: 1 hour) */
  intervalMs: number
  /** Memories below this effective importance get pruned (default: 0.05) */
  pruneThreshold: number
  /** Minimum age in hours before a memory can be pruned (default: 24) */
  minAgeHours: number
  /** Importance threshold for consolidation candidates (default: 0.6) */
  consolidationThreshold: number
  /** Minimum access count to be considered for consolidation (default: 3) */
  consolidationMinAccesses: number
  /** Minimum age in hours before consolidation (default: 48) */
  consolidationMinAgeHours: number
  /** Maximum memories to process per cycle (prevents long-running ticks) */
  batchSize: number
}

const DEFAULT_CONFIG: DecayConfig = {
  intervalMs: 60 * 60 * 1000,      // 1 hour
  pruneThreshold: 0.05,
  minAgeHours: 24,
  consolidationThreshold: 0.6,
  consolidationMinAccesses: 3,
  consolidationMinAgeHours: 48,
  batchSize: 200,
}

// ─── Ebbinghaus Forgetting Curve ────────────────────────────

/**
 * Calculate retention factor using the forgetting curve.
 * @param hoursElapsed — hours since last access
 * @param stability — memory stability (higher = slower decay). Derived from 1/decayRate.
 * @returns retention 0-1
 */
function forgettingCurve(hoursElapsed: number, stability: number): number {
  if (stability <= 0) return 0
  return Math.exp(-hoursElapsed / stability)
}

/**
 * Effective importance = base importance * retention.
 * This is the "real" importance of a memory at the current moment.
 */
function effectiveImportance(entry: EpisodicEntry): number {
  const now = Date.now()
  const lastAccessed = new Date(entry.lastAccessed).getTime()
  const hoursElapsed = Math.max(0, (now - lastAccessed) / (1000 * 60 * 60))

  // Stability is inverse of decay rate (higher stability = slower forgetting)
  // Access count boosts stability (spaced repetition effect)
  const stabilityBoost = 1 + Math.log2(1 + entry.accessCount) * 0.3
  const stability = (1 / Math.max(0.001, entry.decayRate)) * stabilityBoost

  const retention = forgettingCurve(hoursElapsed, stability)
  return entry.importance * retention
}

// ─── Decay Service ──────────────────────────────────────────

export class MemoryDecayService {
  private config: DecayConfig
  private timer: ReturnType<typeof setInterval> | null = null
  private bus = getEventBus()
  private running = false

  constructor(config: Partial<DecayConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** Start the periodic decay loop */
  start(): void {
    if (this.timer) return

    console.log(`[Decay] Starting memory decay service (interval: ${this.config.intervalMs}ms)`)

    // Run immediately on start, then on interval
    this.tick().catch((err) => console.error('[Decay] Initial tick failed:', err))

    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('[Decay] Tick failed:', err))
    }, this.config.intervalMs)
  }

  /** Stop the periodic decay loop */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      console.log('[Decay] Memory decay service stopped')
    }
  }

  /** Single decay + consolidation + prune cycle */
  async tick(): Promise<DecayTickResult> {
    if (this.running) {
      console.log('[Decay] Skipping — previous tick still running')
      return { decayed: 0, consolidated: 0, pruned: 0, processed: 0 }
    }

    this.running = true
    const start = Date.now()

    try {
      const db = getDatabase()

      // 1. Fetch episodic memories ordered by last_accessed (oldest first)
      const rows = db.all<RawRow>(
        `SELECT id, content, context, emotional_valence, importance, timestamp,
                last_accessed, access_count, decay_rate, tags, metadata
         FROM episodic_memories
         ORDER BY last_accessed ASC
         LIMIT ?`,
        this.config.batchSize
      )

      let decayed = 0
      let consolidated = 0
      let pruned = 0

      for (const row of rows) {
        const entry = deserializeRow(row)
        const effImportance = effectiveImportance(entry)

        // Calculate age in hours
        const ageHours = (Date.now() - new Date(entry.timestamp).getTime()) / (1000 * 60 * 60)

        // ── Prune: memory has decayed below threshold and is old enough ──
        if (effImportance < this.config.pruneThreshold && ageHours >= this.config.minAgeHours) {
          this.pruneMemory(db, entry)
          pruned++
          continue
        }

        // ── Consolidate: important, well-accessed, old memories → semantic ──
        if (
          effImportance >= this.config.consolidationThreshold &&
          entry.accessCount >= this.config.consolidationMinAccesses &&
          ageHours >= this.config.consolidationMinAgeHours
        ) {
          const didConsolidate = this.consolidateMemory(db, entry)
          if (didConsolidate) consolidated++
        }

        // ── Decay: update stored importance to match effective importance ──
        if (Math.abs(entry.importance - effImportance) > 0.01) {
          db.run(
            `UPDATE episodic_memories SET importance = ? WHERE id = ?`,
            Math.max(0, effImportance),
            entry.id
          )
          decayed++
        }
      }

      const elapsed = Date.now() - start
      const result: DecayTickResult = {
        decayed,
        consolidated,
        pruned,
        processed: rows.length,
        elapsedMs: elapsed,
      }

      this.bus.emitEvent('system:log', {
        level: 'debug',
        message: `[Decay] Tick complete: ${rows.length} processed, ${decayed} decayed, ${consolidated} consolidated, ${pruned} pruned (${elapsed}ms)`,
        data: result,
      })

      return result
    } finally {
      this.running = false
    }
  }

  // ─── Consolidation ────────────────────────────────────────

  /**
   * Promote an episodic memory to a semantic memory.
   * Extracts a fact/lesson from the episode content.
   * Returns true if consolidation created a new semantic entry.
   */
  private consolidateMemory(db: ReturnType<typeof getDatabase>, entry: EpisodicEntry): boolean {
    // Check if already consolidated (tagged)
    if (entry.tags.includes('consolidated')) return false

    // Extract a semantic triple from the episodic content
    const triple = this.extractSemanticTriple(entry)
    if (!triple) return false

    // Check for duplicate semantic memory
    const existing = db.get<{ id: string }>(
      `SELECT id FROM semantic_memories WHERE subject = ? AND predicate = ?`,
      triple.subject,
      triple.predicate
    )

    if (!existing) {
      // Create new semantic memory
      const { randomUUID } = require('crypto')
      const id = randomUUID()
      const now = new Date().toISOString()

      db.run(
        `INSERT INTO semantic_memories
          (id, subject, predicate, object, confidence, source, created_at, updated_at, access_count, tags, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        id,
        triple.subject,
        triple.predicate,
        triple.object,
        Math.min(1, entry.importance + 0.1), // slightly boost confidence
        `consolidated-from:${entry.id}`,
        now,
        now,
        JSON.stringify(['auto-consolidated', ...entry.tags]),
        JSON.stringify({ sourceEpisodeId: entry.id, consolidatedAt: now })
      )
    } else {
      // Update existing — boost confidence
      db.run(
        `UPDATE semantic_memories SET confidence = MIN(1.0, confidence + 0.1), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        existing.id
      )
    }

    // Mark episodic memory as consolidated (won't be consolidated again)
    const updatedTags = JSON.stringify([...entry.tags, 'consolidated'])
    db.run(`UPDATE episodic_memories SET tags = ? WHERE id = ?`, updatedTags, entry.id)

    this.bus.emitEvent('system:log', {
      level: 'info',
      message: `[Decay] Consolidated episodic → semantic: "${triple.subject} ${triple.predicate} ${triple.object}"`,
      data: { episodicId: entry.id },
    })

    return true
  }

  /**
   * Extract a semantic triple (subject-predicate-object) from episodic content.
   * Uses simple heuristic extraction — no LLM needed.
   */
  private extractSemanticTriple(
    entry: EpisodicEntry
  ): { subject: string; predicate: string; object: string } | null {
    const content = entry.content.trim()

    // Try to detect pattern: "Task: X — Result: Y" or similar structured content
    const taskMatch = content.match(/^(?:task|completed|finished):\s*(.+?)(?:\s*[-—]\s*(?:result|outcome):\s*(.+))?$/i)
    if (taskMatch) {
      return {
        subject: 'brainwave',
        predicate: 'completed-task',
        object: (taskMatch[2] ?? taskMatch[1]).slice(0, 200),
      }
    }

    // Try to detect lesson pattern
    const lessonMatch = content.match(/^(?:lesson|learned|insight):\s*(.+)$/i)
    if (lessonMatch) {
      return {
        subject: 'system',
        predicate: 'learned',
        object: lessonMatch[1].slice(0, 200),
      }
    }

    // Fallback: use the whole content as the object with a generic predicate
    if (content.length > 20 && entry.importance >= 0.7) {
      return {
        subject: 'experience',
        predicate: 'observation',
        object: content.slice(0, 200),
      }
    }

    return null
  }

  // ─── Pruning ──────────────────────────────────────────────

  /** Remove a memory and its index entries */
  private pruneMemory(db: ReturnType<typeof getDatabase>, entry: EpisodicEntry): void {
    // Remove FTS index
    db.run(`DELETE FROM fts_index WHERE memory_id = ? AND memory_type = 'episodic'`, entry.id)

    // Remove embeddings
    db.run(`DELETE FROM embeddings WHERE memory_id = ? AND memory_type = 'episodic'`, entry.id)

    // Remove the memory itself
    db.run(`DELETE FROM episodic_memories WHERE id = ?`, entry.id)

    this.bus.emitEvent('system:log', {
      level: 'debug',
      message: `[Decay] Pruned low-importance memory: ${entry.content.slice(0, 60)}...`,
      data: { id: entry.id, importance: entry.importance },
    })
  }
}

// ─── Result Type ────────────────────────────────────────────

export interface DecayTickResult {
  decayed: number
  consolidated: number
  pruned: number
  processed: number
  elapsedMs?: number
}

// ─── Internal Row Type ──────────────────────────────────────

interface RawRow {
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

function deserializeRow(row: RawRow): EpisodicEntry {
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

// ─── Singleton ──────────────────────────────────────────────

let instance: MemoryDecayService | null = null

export function getDecayService(config?: Partial<DecayConfig>): MemoryDecayService {
  if (!instance) {
    instance = new MemoryDecayService(config)
  }
  return instance
}
