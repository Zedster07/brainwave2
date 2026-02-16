/**
 * Agent Pool — Manages agent instances, concurrency, and task routing
 *
 * Maintains a registry of all agent types, routes sub-tasks to the
 * correct agent, and limits concurrent agent executions.
 */
import { BaseAgent, type AgentContext, type AgentResult, type SubTask } from './base-agent'
import { PlannerAgent } from './planner'
import { ResearcherAgent } from './researcher'
import { CoderAgent } from './coder'
import { ReviewerAgent } from './reviewer'
import { ReflectionAgent } from './reflection'
import { ExecutorAgent } from './executor'
import { getEventBus, type AgentType } from './event-bus'
import { randomUUID } from 'crypto'
import { getMaxDelegationDepth, MAX_PARALLEL_SUBAGENTS } from './delegation'

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
  private agentStates = new Map<AgentType, { state: 'idle' | 'thinking' | 'acting' | 'waiting'; taskId?: string }>()

  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent

    // Track real agent state from events
    this.bus.onEvent('agent:thinking', (data) => {
      this.agentStates.set(data.agentType, { state: 'thinking', taskId: data.taskId })
    })
    this.bus.onEvent('agent:completed', (data) => {
      this.agentStates.set(data.agentType, { state: 'idle' })
    })
    this.bus.onEvent('agent:error', (data) => {
      this.agentStates.set(data.agentType, { state: 'idle' })
    })
  }

  /** Register built-in agents. Called during app startup. */
  registerDefaults(): void {
    // Core agents with full implementations
    this.registry.register(new PlannerAgent())
    this.registry.register(new ResearcherAgent())
    this.registry.register(new CoderAgent())
    this.registry.register(new ReviewerAgent())
    this.registry.register(new ReflectionAgent())

    // Extended agents — use generic fallback with their model configs
    this.registry.register(new GenericAgent('writer', ['writing', 'content-creation', 'documentation'], 'Creative writing, documentation, and content generation'))
    this.registry.register(new GenericAgent('analyst', ['analysis', 'data-interpretation', 'reasoning'], 'Data analysis, pattern recognition, and strategic reasoning'))
    this.registry.register(new GenericAgent('critic', ['critique', 'evaluation', 'quality-assessment'], 'Critical evaluation, argument analysis, and quality assessment'))
    this.registry.register(new ExecutorAgent())
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

  /** Get state for a specific agent */
  getAgentState(type: AgentType): { state: 'idle' | 'thinking' | 'acting' | 'waiting'; taskId?: string } {
    return this.agentStates.get(type) ?? { state: 'idle' }
  }

  /** Get state for all agents */
  getAllAgentStates(): Map<AgentType, { state: 'idle' | 'thinking' | 'acting' | 'waiting'; taskId?: string }> {
    return this.agentStates
  }

  /** Update max concurrent agents */
  setMaxConcurrent(max: number): void {
    this.maxConcurrent = Math.max(1, Math.min(max, 10))
    this.drainQueue()
  }

  // ─── Internal ─────────────────────────────────────────────

  private async run(agent: BaseAgent, subTask: SubTask, context: AgentContext): Promise<AgentResult> {
    this.activeCount++

    // Inject delegation capability if not at max depth
    const currentDepth = context.delegationDepth ?? 0
    const effectiveMaxDepth = getMaxDelegationDepth()
    if (currentDepth < effectiveMaxDepth && !context.delegateFn) {
      // Serial delegation (delegate_to_agent) — one sub-agent at a time
      context.delegateFn = async (agentType: AgentType, task: string) => {
        const delegatedTask: SubTask = {
          id: `delegate-${randomUUID().slice(0, 8)}`,
          description: task,
          assignedAgent: agentType,
          status: 'pending',
          dependencies: [],
          attempts: 0,
          maxAttempts: 1,
        }
        const delegatedContext: AgentContext = {
          ...context,
          delegationDepth: currentDepth + 1,
          taskId: delegatedTask.id,
          delegateFn: undefined, // Will be re-injected by run() at the next level
          parallelDelegateFn: undefined, // Will be re-injected by run() at the next level
        }
        console.log(`[AgentPool] Delegation: ${agent.type} → ${agentType} (depth ${currentDepth + 1}) | "${task.slice(0, 120)}"`)
        return this.executeTask(delegatedTask, delegatedContext)
      }

      // Parallel delegation (use_subagents) — multiple sub-agents concurrently
      context.parallelDelegateFn = async (tasks: Array<{ agent: AgentType; task: string }>) => {
        const capped = tasks.slice(0, MAX_PARALLEL_SUBAGENTS)
        console.log(`[AgentPool] Parallel delegation: ${agent.type} → [${capped.map(t => t.agent).join(', ')}] (depth ${currentDepth + 1})`)

        const executions = capped.map((t) => {
          const delegatedTask: SubTask = {
            id: `parallel-${randomUUID().slice(0, 8)}`,
            description: t.task,
            assignedAgent: t.agent,
            status: 'pending',
            dependencies: [],
            attempts: 0,
            maxAttempts: 1,
          }
          const delegatedContext: AgentContext = {
            ...context,
            delegationDepth: currentDepth + 1,
            taskId: delegatedTask.id,
            delegateFn: undefined,
            parallelDelegateFn: undefined,
            delegationContext: {
              parentTaskId: context.taskId,
              parentSummary: `Parent agent (${agent.type}) delegated this sub-task as part of parallel execution.`,
              relevantFiles: [],
              specificInstructions: t.task,
            },
          }
          return this.executeTask(delegatedTask, delegatedContext)
        })

        return Promise.all(executions)
      }
    }

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
  readonly capabilities: string[]
  readonly description: string

  constructor(agentType: AgentType, capabilities: string[] = ['general'], description?: string) {
    super()
    this.type = agentType
    this.capabilities = capabilities
    this.description = description ?? `Generic fallback agent acting as "${agentType}"`
  }

  protected getSystemPrompt(context: AgentContext): string {
    return `You are a ${this.type} agent in the Brainwave system.

Your role is to complete the assigned task as a ${this.type} specialist.
Capabilities: ${this.capabilities.join(', ')}

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
