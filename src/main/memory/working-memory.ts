/**
 * Working Memory — Transient context for the active task
 *
 * Like human RAM: limited capacity, not persisted, cleared between tasks.
 * Holds the current plan, recent results, and a scratchpad for agents.
 */
import type { TaskPlan, SubTask, AgentResult } from '../agents/base-agent'

// ─── Types ──────────────────────────────────────────────────

export interface WorkingMemoryState {
  currentTask: { id: string; prompt: string } | null
  currentPlan: TaskPlan | null
  activeSubTasks: SubTask[]
  recentResults: Array<{ subTaskId: string; result: AgentResult }>
  activeContext: string                 // summarized context string
  scratchpad: Record<string, unknown>   // temporary kv store for agents
  itemCount: number
}

// ─── Working Memory ─────────────────────────────────────────

export class WorkingMemory {
  private currentTask: { id: string; prompt: string } | null = null
  private currentPlan: TaskPlan | null = null
  private activeSubTasks: SubTask[] = []
  private recentResults: Array<{ subTaskId: string; result: AgentResult }> = []
  private scratchpad = new Map<string, unknown>()
  private activeContext = ''
  private maxResults: number

  constructor(maxResults = 10) {
    this.maxResults = maxResults
  }

  // ─── Task Lifecycle ─────────────────────────────────────

  /** Set the current active task */
  setTask(taskId: string, prompt: string): void {
    this.clear()
    this.currentTask = { id: taskId, prompt }
    this.activeContext = prompt
  }

  /** Set the plan for the current task */
  setPlan(plan: TaskPlan): void {
    this.currentPlan = plan
    this.activeSubTasks = [...plan.subTasks]
  }

  /** Record a sub-task result */
  addResult(subTaskId: string, result: AgentResult): void {
    this.recentResults.push({ subTaskId, result })
    // Evict oldest if over capacity
    if (this.recentResults.length > this.maxResults) {
      this.recentResults.shift()
    }
    // Update active sub-tasks
    this.activeSubTasks = this.activeSubTasks.filter((st) => st.id !== subTaskId)
  }

  /** Update a sub-task status */
  updateSubTask(subTaskId: string, status: SubTask['status']): void {
    const st = this.activeSubTasks.find((s) => s.id === subTaskId)
    if (st) st.status = status
  }

  /** Clear all working memory (between tasks) */
  clear(): void {
    this.currentTask = null
    this.currentPlan = null
    this.activeSubTasks = []
    this.recentResults = []
    this.scratchpad.clear()
    this.activeContext = ''
  }

  // ─── Scratchpad (agent temp storage) ────────────────────

  /** Store a value in the scratchpad */
  set(key: string, value: unknown): void {
    this.scratchpad.set(key, value)
  }

  /** Get a value from the scratchpad */
  get<T = unknown>(key: string): T | undefined {
    return this.scratchpad.get(key) as T | undefined
  }

  /** Delete a value from the scratchpad */
  delete(key: string): boolean {
    return this.scratchpad.delete(key)
  }

  // ─── Context Building ──────────────────────────────────

  /** Update the active context summary */
  setContext(context: string): void {
    this.activeContext = context
  }

  /** Build a context string for agents (injected into prompts) */
  buildContextString(): string {
    const parts: string[] = []

    if (this.currentTask) {
      parts.push(`CURRENT TASK: ${this.currentTask.prompt}`)
    }

    if (this.currentPlan) {
      const completed = this.currentPlan.subTasks.filter((st) => st.status === 'completed').length
      const total = this.currentPlan.subTasks.length
      parts.push(`PLAN PROGRESS: ${completed}/${total} steps complete (${this.currentPlan.estimatedComplexity})`)
    }

    if (this.recentResults.length > 0) {
      parts.push('RECENT RESULTS:')
      for (const { subTaskId, result } of this.recentResults.slice(-5)) {
        const summary = typeof result.output === 'string'
          ? result.output
          : JSON.stringify(result.output)
        parts.push(`  [${subTaskId}] ${result.status} (confidence: ${result.confidence}) → ${summary}`)
      }
    }

    if (this.scratchpad.size > 0) {
      parts.push(`SCRATCHPAD: ${[...this.scratchpad.keys()].join(', ')}`)
    }

    return parts.join('\n')
  }

  // ─── Getters ───────────────────────────────────────────

  getState(): WorkingMemoryState {
    return {
      currentTask: this.currentTask,
      currentPlan: this.currentPlan,
      activeSubTasks: [...this.activeSubTasks],
      recentResults: [...this.recentResults],
      activeContext: this.activeContext,
      scratchpad: Object.fromEntries(this.scratchpad),
      itemCount: this.recentResults.length + this.scratchpad.size + (this.currentPlan ? 1 : 0),
    }
  }

  getCurrentTaskId(): string | null {
    return this.currentTask?.id ?? null
  }

  getPlan(): TaskPlan | null {
    return this.currentPlan
  }

  getResults(): Array<{ subTaskId: string; result: AgentResult }> {
    return [...this.recentResults]
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: WorkingMemory | null = null

export function getWorkingMemory(): WorkingMemory {
  if (!instance) {
    instance = new WorkingMemory()
  }
  return instance
}
