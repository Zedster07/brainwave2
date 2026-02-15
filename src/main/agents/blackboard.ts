/**
 * Shared Context Blackboard
 *
 * An in-memory store that lets agents share intermediate findings during
 * multi-step plan execution.  Scoped by planId so each plan has its own
 * isolated namespace.  Agents write entries during their tool loop and
 * later agents in the DAG can read them for better context.
 *
 * Lifecycle:
 *   1. Orchestrator creates a Blackboard instance per plan
 *   2. Every AgentContext gets a BlackboardHandle (planId + ref)
 *   3. executeWithTools() injects blackboard content into the prompt
 *   4. After successful tool calls, key findings are auto-written
 *   5. Orchestrator clears the blackboard when the plan completes
 */

import type { AgentType } from './base-agent'

// ─── Types ───────────────────────────────────────────────────────────

export interface BlackboardEntry {
  key: string
  value: string
  agentType: AgentType
  taskId: string
  timestamp: number
}

export interface BlackboardHandle {
  planId: string
  board: Blackboard
}

// ─── Blackboard ──────────────────────────────────────────────────────

export class Blackboard {
  /** planId → entries */
  private store = new Map<string, BlackboardEntry[]>()
  /** planId → creation timestamp (for TTL cleanup) */
  private created = new Map<string, number>()

  private static instance: Blackboard | null = null

  /** Max age before a plan's data is eligible for cleanup (10 min) */
  private static TTL_MS = 10 * 60 * 1000
  /** Max entries per plan (prevent runaway writes) */
  private static MAX_ENTRIES_PER_PLAN = 50

  static getInstance(): Blackboard {
    if (!Blackboard.instance) {
      Blackboard.instance = new Blackboard()
    }
    return Blackboard.instance
  }

  /** Reset singleton — useful for tests */
  static resetInstance(): void {
    Blackboard.instance = null
  }

  // ── Write ────────────────────────────────────────────────────────

  /**
   * Write a key–value entry to the blackboard for a given plan.
   * Duplicate keys from the same agent+task overwrite previous entries.
   */
  write(planId: string, key: string, value: string, agentType: AgentType, taskId: string): void {
    if (!this.store.has(planId)) {
      this.store.set(planId, [])
      this.created.set(planId, Date.now())
    }

    const entries = this.store.get(planId)!

    // Overwrite if same key + agent + task already exists
    const existingIdx = entries.findIndex(
      (e) => e.key === key && e.agentType === agentType && e.taskId === taskId
    )

    const entry: BlackboardEntry = {
      key,
      value,
      agentType,
      taskId,
      timestamp: Date.now(),
    }

    if (existingIdx >= 0) {
      entries[existingIdx] = entry
    } else if (entries.length < Blackboard.MAX_ENTRIES_PER_PLAN) {
      entries.push(entry)
    } else {
      console.warn(`[Blackboard] Plan "${planId}" hit max entries (${Blackboard.MAX_ENTRIES_PER_PLAN}), dropping write for key "${key}"`)
    }
  }

  // ── Read ─────────────────────────────────────────────────────────

  /** Read all entries for a plan */
  readAll(planId: string): BlackboardEntry[] {
    return this.store.get(planId) ?? []
  }

  /** Read entries matching a specific key */
  read(planId: string, key: string): BlackboardEntry[] {
    return (this.store.get(planId) ?? []).filter((e) => e.key === key)
  }

  /** Read all entries written by a specific agent type */
  readByAgent(planId: string, agentType: AgentType): BlackboardEntry[] {
    return (this.store.get(planId) ?? []).filter((e) => e.agentType === agentType)
  }

  /** Read all entries written during a specific subtask */
  readByTask(planId: string, taskId: string): BlackboardEntry[] {
    return (this.store.get(planId) ?? []).filter((e) => e.taskId === taskId)
  }

  /** Get the number of entries for a plan */
  count(planId: string): number {
    return this.store.get(planId)?.length ?? 0
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /** Clear all entries for a completed plan */
  clear(planId: string): void {
    this.store.delete(planId)
    this.created.delete(planId)
  }

  /** Run TTL cleanup — call periodically to evict stale plans */
  cleanup(): number {
    const now = Date.now()
    let evicted = 0
    for (const [planId, createdAt] of this.created) {
      if (now - createdAt > Blackboard.TTL_MS) {
        this.clear(planId)
        evicted++
      }
    }
    if (evicted > 0) {
      console.log(`[Blackboard] TTL cleanup: evicted ${evicted} stale plan(s)`)
    }
    return evicted
  }

  /** Get number of active plans */
  get activePlans(): number {
    return this.store.size
  }

  // ── Formatting ───────────────────────────────────────────────────

  /**
   * Build a prompt-ready string of blackboard content for an agent.
   * Excludes entries written by the requesting agent+task to avoid echo.
   */
  formatForPrompt(planId: string, excludeAgent?: AgentType, excludeTaskId?: string): string {
    const entries = this.readAll(planId)
    if (entries.length === 0) return ''

    // Filter out the requesting agent's own writes for this task
    const relevant = entries.filter(
      (e) => !(e.agentType === excludeAgent && e.taskId === excludeTaskId)
    )
    if (relevant.length === 0) return ''

    const lines = relevant.map((e) => {
      const age = Math.round((Date.now() - e.timestamp) / 1000)
      return `  [${e.agentType}/${e.taskId}] (${age}s ago) ${e.key}: ${e.value}`
    })

    return (
      `\n\nSHARED CONTEXT (findings from other agents in this plan):\n` +
      lines.join('\n') +
      `\n`
    )
  }
}
