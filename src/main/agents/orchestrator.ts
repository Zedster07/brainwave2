/**
 * Orchestrator Agent — The CEO of the agent system
 *
 * Receives user tasks, consults memory, delegates to Planner,
 * executes the plan via the Agent Pool, compiles results.
 *
 * Flow: User Task → Memory Recall → Plan → Execute DAG → Review → Reflect → Respond
 */
import { randomUUID } from 'crypto'
import { BaseAgent, type AgentContext, type AgentResult, type SubTask, type TaskPlan } from './base-agent'
import { PlannerAgent } from './planner'
import { getEventBus, type AgentType } from './event-bus'
import { getDatabase } from '../db/database'
import { getMemoryManager } from '../memory'
import { getWorkingMemory } from '../memory/working-memory'
import { ReflectionAgent } from './reflection'

// ─── Task Record (stored in DB) ────────────────────────────

export interface TaskRecord {
  id: string
  prompt: string
  priority: 'low' | 'normal' | 'high'
  status: 'pending' | 'planning' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
  plan?: TaskPlan
  result?: unknown
  error?: string
  createdAt: number
  completedAt?: number
}

// ─── Orchestrator ───────────────────────────────────────────

export class Orchestrator extends BaseAgent {
  readonly type = 'orchestrator' as const
  readonly capabilities = ['planning', 'delegation', 'monitoring', 'decision-making']
  readonly description = 'Central intelligence — receives tasks, creates plans, delegates, monitors'

  private planner = new PlannerAgent()
  private reflector = new ReflectionAgent()
  private activeTasks = new Map<string, TaskRecord>()
  private agentExecutor: AgentExecutorFn | null = null

  protected getSystemPrompt(_context: AgentContext): string {
    return `You are the Orchestrator — the central intelligence of the Brainwave system.

Your responsibilities:
1. Analyze incoming tasks to understand their nature and complexity
2. Decide the best approach to solve the task
3. Coordinate the execution of sub-tasks
4. Compile final results for the user
5. Report confidence and reasoning transparently

You NEVER do the actual work yourself. You plan, delegate, and oversee.
When making decisions, explain your reasoning. Be transparent.

You have access to these specialist agents:
- Planner: Decomposes tasks into sub-tasks
- Researcher: Searches the web, reads docs, finds answers
- Coder: Writes, modifies, and explains code
- Reviewer: Quality checks all outputs
- Reflection: Learns from completed tasks

When the task is simple enough for a single agent, skip the planner and assign directly.`
  }

  /** Register the function used to execute individual agent tasks */
  setExecutor(executor: AgentExecutorFn): void {
    this.agentExecutor = executor
  }

  /** Main entry point — submit a user task */
  async submitTask(prompt: string, priority: 'low' | 'normal' | 'high' = 'normal'): Promise<TaskRecord> {
    const taskId = randomUUID()
    const task: TaskRecord = {
      id: taskId,
      prompt,
      priority,
      status: 'pending',
      createdAt: Date.now(),
    }

    this.activeTasks.set(taskId, task)

    // Persist to DB
    this.db.run(
      `INSERT INTO tasks (id, title, description, status, priority, created_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      taskId,
      prompt.slice(0, 200),
      prompt,
      'pending',
      priority === 'high' ? 0.9 : priority === 'normal' ? 0.5 : 0.2
    )

    this.bus.emitEvent('task:submitted', { taskId, prompt, priority })

    // Run asynchronously — don't block the caller
    this.processTask(task).catch((err) => {
      console.error(`[Orchestrator] Task ${taskId} failed:`, err)
      this.failTask(task, err instanceof Error ? err.message : String(err))
    })

    return task
  }

  /** Cancel a running task */
  cancelTask(taskId: string): boolean {
    const task = this.activeTasks.get(taskId)
    if (!task || task.status === 'completed' || task.status === 'failed') return false

    task.status = 'cancelled'
    this.db.run(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`, taskId)
    this.bus.emitEvent('task:cancelled', { taskId })

    return true
  }

  /** Get all active tasks */
  getActiveTasks(): TaskRecord[] {
    return [...this.activeTasks.values()]
  }

  /** Get a specific task */
  getTask(taskId: string): TaskRecord | undefined {
    return this.activeTasks.get(taskId)
  }

  // ─── Core Processing Pipeline ────────────────────────────

  private async processTask(task: TaskRecord): Promise<void> {
    try {
      // 0. Memory recall — gather relevant context from past experiences
      const memoryManager = getMemoryManager()
      const workingMemory = getWorkingMemory()

      workingMemory.setTask(task.id, task.prompt)

      let relevantMemories: string[] = []
      try {
        relevantMemories = await memoryManager.recallForContext(task.prompt, 8)
        if (relevantMemories.length > 0) {
          workingMemory.set('recalled_memories', JSON.stringify(relevantMemories))
          this.bus.emitEvent('system:log', {
            level: 'info',
            message: `Recalled ${relevantMemories.length} relevant memories for task`,
            data: { taskId: task.id },
          })
        }
      } catch (err) {
        console.warn('[Orchestrator] Memory recall failed, continuing without:', err)
      }

      // 1. Planning phase
      task.status = 'planning'
      this.db.run(`UPDATE tasks SET status = 'planning' WHERE id = ?`, task.id)
      this.bus.emitEvent('task:planning', { taskId: task.id })

      const plan = await this.planner.decompose(task.id, task.prompt)
      task.plan = plan

      // Store plan in DB
      this.db.run(
        `UPDATE tasks SET plan = ?, assigned_agent = 'orchestrator' WHERE id = ?`,
        JSON.stringify(plan),
        task.id
      )

      // 2. Execution phase — run the DAG
      task.status = 'in_progress'
      this.db.run(`UPDATE tasks SET status = 'in_progress', started_at = CURRENT_TIMESTAMP WHERE id = ?`, task.id)

      const results = await this.executePlan(task, plan, relevantMemories)

      // Check if task was cancelled during execution
      if (task.status === 'cancelled') return

      // 3. Compile results
      const finalResult = this.compileResults(plan, results)

      // 4. Mark complete
      task.status = 'completed'
      task.result = finalResult
      task.completedAt = Date.now()

      this.db.run(
        `UPDATE tasks SET status = 'completed', result = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
        JSON.stringify(finalResult),
        task.id
      )

      this.bus.emitEvent('task:completed', { taskId: task.id, result: finalResult })

      // 5. Store the experience as episodic memory for future recall
      try {
        await memoryManager.storeEpisodic({
          content: `Task completed: "${task.prompt.slice(0, 200)}". Result: ${JSON.stringify(finalResult).slice(0, 500)}`,
          source: 'orchestrator',
          importance: task.priority === 'high' ? 0.8 : task.priority === 'normal' ? 0.5 : 0.3,
          emotionalValence: 0.6, // positive — successful completion
          tags: ['task-completed', `priority-${task.priority}`],
          participants: ['orchestrator', ...plan.requiredAgents],
        })
      } catch (err) {
        console.warn('[Orchestrator] Failed to store task memory:', err)
      }

      // 6. Auto-reflect (async, non-blocking — don't fail the task if reflection fails)
      this.triggerReflection(task, plan, results).catch((err) => {
        console.warn('[Orchestrator] Reflection failed:', err)
      })

      // 7. Clear working memory for this task
      workingMemory.clear()
    } catch (err) {
      this.failTask(task, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  /**
   * Trigger post-task reflection (fire-and-forget).
   * Builds a reflective context from the task, plan, and all results,
   * then lets the ReflectionAgent extract lessons and propose rules.
   */
  private async triggerReflection(
    task: TaskRecord,
    plan: TaskPlan,
    results: Map<string, AgentResult>
  ): Promise<void> {
    const subTask: SubTask = {
      id: `reflection-${task.id}`,
      description: `Reflect on completed task: ${task.prompt}`,
      assignedAgent: 'reflection' as AgentType,
      dependencies: [],
      priority: 'low',
      status: 'pending',
    }

    // Build sibling results so reflection can see all agent outputs
    const siblingResults = new Map<string, AgentResult>()
    for (const [id, result] of results) {
      siblingResults.set(id, result)
    }

    const context: AgentContext = {
      taskId: task.id,
      parentTaskId: task.id,
      conversationHistory: [],
      relevantMemories: [],
      siblingResults,
      metadata: {
        originalPrompt: task.prompt,
        plan: JSON.stringify(plan),
        priority: task.priority,
      },
    }

    const reflectionResult = await this.reflector.execute(subTask, context)

    this.bus.emitEvent('agent:completed', {
      taskId: task.id,
      agentType: 'reflection',
      result: reflectionResult,
    })
  }

  /**
   * Execute a task plan, respecting the dependency DAG.
   * Independent sub-tasks run in parallel.
   */
  private async executePlan(
    task: TaskRecord,
    plan: TaskPlan,
    relevantMemories: string[] = []
  ): Promise<Map<string, AgentResult>> {
    const results = new Map<string, AgentResult>()
    const remaining = new Set(plan.subTasks.map((st) => st.id))
    const completed = new Set<string>()

    while (remaining.size > 0) {
      // Check for cancellation
      if (task.status === 'cancelled') break

      // Find all tasks whose dependencies are satisfied
      const ready = plan.subTasks.filter(
        (st) =>
          remaining.has(st.id) &&
          st.dependencies.every((dep) => completed.has(dep))
      )

      if (ready.length === 0 && remaining.size > 0) {
        throw new Error(
          `Deadlock: ${remaining.size} tasks remaining but none are ready. ` +
          `Possibly circular dependencies.`
        )
      }

      // Execute ready tasks in parallel
      const executions = ready.map(async (subTask) => {
        subTask.status = 'in-progress'

        this.bus.emitEvent('task:progress', {
          taskId: task.id,
          progress: Math.round(
            ((completed.size) / plan.subTasks.length) * 100
          ),
          currentStep: subTask.description,
        })

        const result = await this.executeSubTask(subTask, {
          taskId: task.id,
          planId: plan.id,
          parentTask: plan.originalTask,
          relevantMemories,
          siblingResults: results,
        })

        results.set(subTask.id, result)

        if (result.status === 'success' || result.status === 'partial') {
          subTask.status = 'completed'
          subTask.result = result.output
          completed.add(subTask.id)
          remaining.delete(subTask.id)

          this.bus.emitEvent('plan:step-completed', {
            taskId: task.id,
            planId: plan.id,
            stepId: subTask.id,
            agentType: subTask.assignedAgent,
          })
        } else {
          // Retry logic
          subTask.attempts++
          if (subTask.attempts < subTask.maxAttempts) {
            subTask.status = 'retrying'
            console.log(
              `[Orchestrator] Retrying ${subTask.id} (attempt ${subTask.attempts + 1}/${subTask.maxAttempts})`
            )
            // Will be picked up in the next loop iteration
          } else {
            subTask.status = 'failed'
            subTask.error = result.error
            remaining.delete(subTask.id)
            completed.add(subTask.id) // Mark as "done" so dependents can see it failed

            this.bus.emitEvent('plan:step-failed', {
              taskId: task.id,
              planId: plan.id,
              stepId: subTask.id,
              error: result.error ?? 'Unknown error',
            })
          }
        }
      })

      await Promise.all(executions)
    }

    // Final progress update
    this.bus.emitEvent('task:progress', {
      taskId: task.id,
      progress: 100,
      currentStep: 'Complete',
    })

    return results
  }

  /**
   * Execute a single sub-task via the registered executor.
   * If no executor is registered, uses the base agent's think() directly.
   */
  private async executeSubTask(subTask: SubTask, context: AgentContext): Promise<AgentResult> {
    if (this.agentExecutor) {
      return this.agentExecutor(subTask, context)
    }

    // Fallback: execute via orchestrator's own LLM (not ideal, but functional)
    console.warn(`[Orchestrator] No agent executor registered, using self for ${subTask.assignedAgent}`)
    return this.execute(subTask, context)
  }

  /** Compile all sub-task results into a final output */
  private compileResults(plan: TaskPlan, results: Map<string, AgentResult>): unknown {
    // For single-task plans, return the result directly
    if (plan.subTasks.length === 1) {
      const only = results.get(plan.subTasks[0].id)
      return only?.output ?? null
    }

    // For multi-task plans, compile a structured summary
    const compiled: Record<string, unknown> = {
      originalTask: plan.originalTask,
      complexity: plan.estimatedComplexity,
      steps: plan.subTasks.map((st) => {
        const result = results.get(st.id)
        return {
          id: st.id,
          description: st.description,
          agent: st.assignedAgent,
          status: st.status,
          output: result?.output,
          confidence: result?.confidence,
          error: st.error,
        }
      }),
      overallConfidence:
        [...results.values()].reduce((sum, r) => sum + r.confidence, 0) / results.size,
    }

    return compiled
  }

  /** Mark a task as failed */
  private failTask(task: TaskRecord, error: string): void {
    task.status = 'failed'
    task.error = error
    this.db.run(
      `UPDATE tasks SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      error,
      task.id
    )
    this.bus.emitEvent('task:failed', { taskId: task.id, error })
  }
}

// ─── Types ──────────────────────────────────────────────────

export type AgentExecutorFn = (subTask: SubTask, context: AgentContext) => Promise<AgentResult>

// ─── Singleton ──────────────────────────────────────────────

let instance: Orchestrator | null = null

export function getOrchestrator(): Orchestrator {
  if (!instance) {
    instance = new Orchestrator()
  }
  return instance
}
