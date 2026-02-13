/**
 * Agent Pool — Manages agent instances, concurrency, and task routing
 *
 * Maintains a registry of all agent types, routes sub-tasks to the
 * correct agent, and limits concurrent agent executions.
 */
import { BaseAgent, type AgentContext, type AgentResult, type SubTask } from './base-agent'
import { PlannerAgent } from './planner'
import { getEventBus, type AgentType } from './event-bus'

// ─── Agent Registry ─────────────────────────────────────────

class AgentRegistry {
  private agents = new Map<AgentType, BaseAgent>()

  register(agent: BaseAgent): void {
    this.agents.set(agent.type, agent)
    console.log(`[AgentRegistry] Registered: ${agent.type} (${agent.capabilities.join(', ')})`)
  }

  get(type: AgentType): BaseAgent | undefined {
    return this.agents.get(type)
  }

  has(type: AgentType): boolean {
    return this.agents.has(type)
  }

  listTypes(): AgentType[] {
    return [...this.agents.keys()]
  }

  listAll(): BaseAgent[] {
    return [...this.agents.values()]
  }

  /** Find agents that have a specific capability */
  findByCapability(capability: string): BaseAgent[] {
    return this.listAll().filter((a) => a.capabilities.includes(capability))
  }
}

// ─── Queued Execution ───────────────────────────────────────

interface QueuedTask {
  subTask: SubTask
  context: AgentContext
  resolve: (result: AgentResult) => void
  reject: (err: Error) => void
}

// ─── Agent Pool ─────────────────────────────────────────────

export class AgentPool {
  readonly registry = new AgentRegistry()
  private bus = getEventBus()
  private queue: QueuedTask[] = []
  private activeCount = 0
  private maxConcurrent: number

  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent
  }

  /** Register built-in agents. Called during app startup. */
  registerDefaults(): void {
    // Phase 1: Planner is built-in
    this.registry.register(new PlannerAgent())

    // Phase 2 agents (researcher, coder, reviewer, reflection) will be
    // registered here as they're built. For now, the GenericAgent below
    // handles all unregistered agent types via a catch-all LLM call.
  }

  /** Execute a sub-task through the correct agent */
  async executeTask(subTask: SubTask, context: AgentContext): Promise<AgentResult> {
    const agent = this.registry.get(subTask.assignedAgent)

    if (!agent) {
      // Use a generic fallback agent for types not yet built
      console.warn(
        `[AgentPool] No agent registered for "${subTask.assignedAgent}", using generic fallback`
      )
      return this.executeWithGeneric(subTask, context)
    }

    // Concurrency control
    if (this.activeCount >= this.maxConcurrent) {
      return new Promise<AgentResult>((resolve, reject) => {
        this.queue.push({ subTask, context, resolve, reject })
        console.log(
          `[AgentPool] Queued task "${subTask.id}" (${this.queue.length} in queue, ${this.activeCount} active)`
        )
      })
    }

    return this.run(agent, subTask, context)
  }

  /** Get pool status */
  getStatus(): { active: number; queued: number; maxConcurrent: number; agents: AgentType[] } {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      agents: this.registry.listTypes(),
    }
  }

  /** Update max concurrent agents */
  setMaxConcurrent(max: number): void {
    this.maxConcurrent = Math.max(1, Math.min(max, 10))
    this.drainQueue()
  }

  // ─── Internal ─────────────────────────────────────────────

  private async run(agent: BaseAgent, subTask: SubTask, context: AgentContext): Promise<AgentResult> {
    this.activeCount++

    try {
      const result = await agent.execute(subTask, context)
      return result
    } finally {
      this.activeCount--
      this.drainQueue()
    }
  }

  /** Process queued tasks when capacity becomes available */
  private drainQueue(): void {
    while (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const next = this.queue.shift()!
      const agent = this.registry.get(next.subTask.assignedAgent)

      if (agent) {
        this.run(agent, next.subTask, next.context)
          .then(next.resolve)
          .catch(next.reject)
      } else {
        this.executeWithGeneric(next.subTask, next.context)
          .then(next.resolve)
          .catch(next.reject)
      }
    }
  }

  /**
   * Generic fallback — executes any sub-task via a general-purpose LLM call.
   * Used for agent types not yet implemented (Phase 2 agents).
   */
  private async executeWithGeneric(subTask: SubTask, context: AgentContext): Promise<AgentResult> {
    const generic = new GenericAgent(subTask.assignedAgent)
    this.activeCount++

    try {
      return await generic.execute(subTask, context)
    } finally {
      this.activeCount--
      this.drainQueue()
    }
  }
}

// ─── Generic Agent (fallback for unregistered types) ────────

class GenericAgent extends BaseAgent {
  readonly type: AgentType
  readonly capabilities = ['general']
  readonly description: string

  constructor(agentType: AgentType) {
    super()
    this.type = agentType
    this.description = `Generic fallback agent acting as "${agentType}"`
  }

  protected getSystemPrompt(context: AgentContext): string {
    return `You are a ${this.type} agent in the Brainwave system.

Your role is to complete the assigned task as a ${this.type} specialist.
Be thorough, accurate, and clear in your output.

If you cannot complete the task, explain why and suggest what would be needed.

Always report your confidence level (0-1) and reasoning.`
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: AgentPool | null = null

export function getAgentPool(): AgentPool {
  if (!instance) {
    instance = new AgentPool()
    instance.registerDefaults()
  }
  return instance
}
