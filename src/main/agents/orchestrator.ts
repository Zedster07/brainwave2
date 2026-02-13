/**
 * Orchestrator Agent — The CEO of the agent system
 *
 * Receives user tasks, consults memory, delegates to Planner,
 * executes the plan via the Agent Pool, compiles results.
 *
 * Flow: User Task → Triage → (Direct Reply | Single Agent | Full Pipeline)
 *
 * Triage classifies prompts into 3 lanes:
 * - conversational: greetings, small talk → instant reply (no agents)
 * - direct: single-agent tasks → skip planner, go straight to the right agent
 * - complex: multi-step work → full planner → DAG → reflection
 */
import { randomUUID } from 'crypto'
import { BaseAgent, type AgentContext, type AgentResult, type SubTask, type TaskPlan } from './base-agent'
import { PlannerAgent } from './planner'
import { getEventBus, type AgentType } from './event-bus'
import { getDatabase } from '../db/database'
import { getMemoryManager } from '../memory'
import { getWorkingMemory } from '../memory/working-memory'
import { getPeopleStore } from '../memory/people'
import { getProspectiveStore } from '../memory/prospective'
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

// ─── Triage Classification ─────────────────────────────────

type TriageLane = 'conversational' | 'direct' | 'complex'

interface TriageResult {
  lane: TriageLane
  reply?: string          // only for conversational
  agent?: AgentType       // only for direct
  shouldRemember?: boolean // whether this interaction is worth storing in memory
  personInfo?: {           // extracted person data — auto-creates/updates People entries
    name: string
    relationship?: string
    traits?: string[]
  }
  semanticFacts?: Array<{  // extracted facts/preferences — stored as semantic memory
    subject: string
    predicate: string
    object: string
  }>
  reminder?: {             // extracted intention/reminder — stored as prospective memory
    intention: string
    triggerType: 'time' | 'event' | 'condition'
    triggerValue: string
    priority?: number
  }
  reasoning: string
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

You have access to these specialist agents:
- Planner: Decomposes tasks into sub-tasks
- Researcher: Searches the web, reads docs, finds answers
- Coder: Writes, modifies, and explains code
- Reviewer: Quality checks all outputs
- Reflection: Learns from completed tasks

Decision framework:
- Conversational prompts (greetings, small talk, simple questions) → reply directly
- Single-agent tasks → delegate without planning overhead
- Complex multi-step tasks → use Planner to decompose into sub-tasks`
  }

  // ─── Triage ──────────────────────────────────────────────

  /**
   * Smart triage — classify the prompt into a lane before doing work.
   * This is a single, cheap LLM call that prevents over-engineering simple prompts.
   */
  private async triage(prompt: string, context: AgentContext): Promise<TriageResult> {
    try {
      const { parsed } = await this.thinkJSON<TriageResult>(
        `Classify this user prompt and decide the best processing lane.

PROMPT: "${prompt}"

LANES:
1. "conversational" — greetings, small talk, simple questions that need no tools/agents.
   You MUST provide "reply" with a natural, friendly response.
   Examples: "hello", "what's your name?", "thanks", "how are you?"

2. "direct" — a task clearly suited for ONE specialist agent, no decomposition needed.
   You MUST provide "agent" with one of: researcher, coder, reviewer.
   Examples: "write a fibonacci function", "summarize this article", "review this code"

3. "complex" — multi-step tasks requiring planning, multiple agents, or coordination.
   Examples: "build a REST API with auth", "research X then write code for it"

MEMORY DECISION:
Decide if this interaction is worth remembering long-term ("shouldRemember").
Remember ONLY if the user shares something meaningful:
- Personal info (their name, preferences, background)
- Important facts or decisions
- Context that would be useful in future conversations
Do NOT remember: greetings, small talk, thanks, trivial questions, generic requests.

PERSON EXTRACTION:
If the user mentions a person (themselves or someone else) by name, extract their info into "personInfo".
This includes: user introducing themselves, mentioning colleagues, friends, etc.
Examples:
- "my name is Dada" → { "name": "Dada", "relationship": "owner/creator", "traits": ["developer"] }
- "my friend John is a designer" → { "name": "John", "relationship": "friend", "traits": ["designer"] }
Only include "personInfo" if a person's name is clearly stated.

FACT / PREFERENCE EXTRACTION:
If the user states facts, preferences, or knowledge worth remembering, extract as "semanticFacts".
Each fact is a subject-predicate-object triple.
Examples:
- "I prefer TypeScript over JavaScript" → [{ "subject": "user", "predicate": "prefers", "object": "TypeScript over JavaScript" }]
- "our backend uses Express" → [{ "subject": "project_backend", "predicate": "uses", "object": "Express" }]
- "my favorite color is blue" → [{ "subject": "user", "predicate": "favorite_color_is", "object": "blue" }]
Only include if the user shares actual knowledge or preferences. Do NOT extract from greetings or questions.

REMINDER / INTENTION EXTRACTION:
If the user expresses a future intention or asks for a reminder, extract as "reminder".
Examples:
- "remind me to review the PR tomorrow" → { "intention": "review the PR", "triggerType": "time", "triggerValue": "tomorrow", "priority": 0.7 }
- "I need to deploy before Friday" → { "intention": "deploy", "triggerType": "time", "triggerValue": "before Friday", "priority": 0.8 }
- "when the tests pass, let me know" → { "intention": "notify user", "triggerType": "event", "triggerValue": "tests pass", "priority": 0.5 }
Only include if the user clearly expresses a future intention or reminder.

OUTPUT FORMAT (JSON):
{
  "lane": "conversational" | "direct" | "complex",
  "reply": "your response (only for conversational)",
  "agent": "researcher" | "coder" | "reviewer" (only for direct),
  "shouldRemember": true/false,
  "personInfo": { "name": "...", "relationship": "...", "traits": ["..."] } (only if a person is mentioned),
  "semanticFacts": [{ "subject": "...", "predicate": "...", "object": "..." }] (only if facts/preferences shared),
  "reminder": { "intention": "...", "triggerType": "time|event|condition", "triggerValue": "...", "priority": 0.5 } (only if reminder/intention expressed),
  "reasoning": "one-line explanation of why this lane was chosen"
}

Be generous with "conversational" — if the user is just chatting, reply directly.
Be generous with "direct" — most prompts need only one agent.
Only use "complex" when the task genuinely requires multiple steps or agents.`,
        context,
        { temperature: 0.2 }
      )

      console.log(`[Orchestrator] Triage → ${parsed.lane}: ${parsed.reasoning}`)
      return parsed
    } catch (err) {
      // If triage itself fails, fall back to full pipeline
      console.warn('[Orchestrator] Triage failed, falling back to complex:', err)
      return { lane: 'complex', reasoning: 'triage failed, using full pipeline' }
    }
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

  /** Get recent task history from DB (persisted across restarts) */
  getTaskHistory(limit = 50): TaskRecord[] {
    const rows = this.db.all(
      `SELECT id, title, description, status, priority, result, error, created_at, completed_at
       FROM tasks ORDER BY created_at DESC LIMIT ?`,
      limit
    ) as Array<{
      id: string
      title: string
      description: string
      status: string
      priority: number
      result: string | null
      error: string | null
      created_at: string
      completed_at: string | null
    }>

    return rows.map((row) => ({
      id: row.id,
      prompt: row.description || row.title,
      priority: row.priority >= 0.8 ? 'high' as const : row.priority >= 0.4 ? 'normal' as const : 'low' as const,
      status: this.mapDbStatus(row.status),
      result: row.result ? this.safeParseJSON(row.result) : undefined,
      error: row.error ?? undefined,
      createdAt: new Date(row.created_at).getTime(),
      completedAt: row.completed_at ? new Date(row.completed_at).getTime() : undefined,
    }))
  }

  private mapDbStatus(dbStatus: string): TaskRecord['status'] {
    const map: Record<string, TaskRecord['status']> = {
      pending: 'pending',
      planning: 'planning',
      in_progress: 'in_progress',
      delegated: 'in_progress',
      blocked: 'pending',
      completed: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
    }
    return map[dbStatus] ?? 'pending'
  }

  private safeParseJSON(str: string): unknown {
    try {
      return JSON.parse(str)
    } catch {
      return str
    }
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

      // 1. Triage — classify the prompt before doing heavy work
      task.status = 'planning'
      this.db.run(`UPDATE tasks SET status = 'planning' WHERE id = ?`, task.id)
      this.bus.emitEvent('task:planning', { taskId: task.id })

      const triageContext: AgentContext = { taskId: task.id, relevantMemories }
      const triage = await this.triage(task.prompt, triageContext)

      // 2. Route based on triage lane
      switch (triage.lane) {
        case 'conversational':
          await this.handleConversational(task, triage, memoryManager)
          break
        case 'direct':
          await this.handleDirect(task, triage, relevantMemories, memoryManager)
          break
        case 'complex':
          await this.handleComplex(task, relevantMemories, memoryManager)
          break
      }

      // 3. Clear working memory
      workingMemory.clear()
    } catch (err) {
      this.failTask(task, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  // ─── Lane Handlers ────────────────────────────────────────

  /**
   * Conversational lane — instant reply, no agents.
   * Cheapest path: triage already generated the reply.
   */
  private async handleConversational(
    task: TaskRecord,
    triage: TriageResult,
    memoryManager: ReturnType<typeof getMemoryManager>
  ): Promise<void> {
    const reply = triage.reply ?? 'Hello! How can I help you?'

    task.status = 'completed'
    task.result = reply
    task.completedAt = Date.now()

    this.db.run(
      `UPDATE tasks SET status = 'completed', result = ?, assigned_agent = 'orchestrator', completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      JSON.stringify(reply),
      task.id
    )

    this.bus.emitEvent('task:completed', { taskId: task.id, result: reply })

    // Auto-create/update person if triage extracted person info
    if (triage.personInfo?.name) {
      try {
        const peopleStore = getPeopleStore()
        const person = peopleStore.store({
          name: triage.personInfo.name,
          relationship: triage.personInfo.relationship,
          traits: triage.personInfo.traits,
        })
        console.log(`[Orchestrator] Created/updated person: ${person.name} (${person.id})`)
      } catch (err) {
        console.warn('[Orchestrator] Failed to store person:', err)
      }
    }

    // Store semantic facts/preferences if triage extracted any
    if (triage.semanticFacts?.length) {
      for (const fact of triage.semanticFacts) {
        try {
          await memoryManager.storeSemantic({
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
            confidence: 0.8,
            source: 'conversation',
            tags: ['user-stated', 'conversational'],
          })
          console.log(`[Orchestrator] Stored semantic fact: ${fact.subject} ${fact.predicate} ${fact.object}`)
        } catch (err) {
          console.warn('[Orchestrator] Failed to store semantic fact:', err)
        }
      }
    }

    // Create prospective memory if triage detected a reminder/intention
    if (triage.reminder) {
      try {
        const prospectiveStore = getProspectiveStore()
        const entry = prospectiveStore.store({
          intention: triage.reminder.intention,
          triggerType: triage.reminder.triggerType,
          triggerValue: triage.reminder.triggerValue,
          priority: triage.reminder.priority ?? 0.5,
          tags: ['user-requested', 'conversational'],
        })
        console.log(`[Orchestrator] Created prospective memory: ${entry.intention} (${entry.id})`)
      } catch (err) {
        console.warn('[Orchestrator] Failed to store prospective memory:', err)
      }
    }

    // Only store episodic memory if triage decided this interaction is worth remembering
    if (triage.shouldRemember) {
      try {
        await memoryManager.storeEpisodic({
          content: `User said: "${task.prompt.slice(0, 200)}". Replied directly (conversational).`,
          source: 'orchestrator',
          importance: 0.3,
          emotionalValence: 0.5,
          tags: ['conversational', 'remembered'],
          participants: ['orchestrator'],
        })
        console.log('[Orchestrator] Stored conversational memory — triage deemed worth remembering')
      } catch {
        // Not critical
      }
    } else {
      console.log('[Orchestrator] Skipped memory storage — trivial conversational input')
    }
  }

  /**
   * Direct lane — skip planner, route to a single agent.
   * Medium cost: one triage call + one agent call, no planning or reflection overhead.
   */
  private async handleDirect(
    task: TaskRecord,
    triage: TriageResult,
    relevantMemories: string[],
    memoryManager: ReturnType<typeof getMemoryManager>
  ): Promise<void> {
    const agentType = triage.agent ?? ('coder' as AgentType)

    // Build a single-step plan inline (no planner LLM call)
    const plan: TaskPlan = {
      id: `plan_${randomUUID().slice(0, 8)}`,
      taskId: task.id,
      originalTask: task.prompt,
      subTasks: [{
        id: 'direct-task',
        description: task.prompt,
        assignedAgent: agentType,
        status: 'pending',
        dependencies: [],
        attempts: 0,
        maxAttempts: 2,
      }],
      estimatedComplexity: 'simple',
      requiredAgents: [agentType],
    }

    task.plan = plan
    this.db.run(
      `UPDATE tasks SET plan = ?, assigned_agent = ? WHERE id = ?`,
      JSON.stringify(plan),
      agentType,
      task.id
    )

    this.bus.emitEvent('plan:created', {
      taskId: task.id,
      planId: plan.id,
      steps: 1,
      agents: [agentType],
    })

    // Execute
    task.status = 'in_progress'
    this.db.run(`UPDATE tasks SET status = 'in_progress', started_at = CURRENT_TIMESTAMP WHERE id = ?`, task.id)

    const results = await this.executePlan(task, plan, relevantMemories)
    if (task.status === 'cancelled') return

    const finalResult = this.compileResults(plan, results)
    await this.completeTask(task, finalResult, plan, memoryManager)
  }

  /**
   * Complex lane — full pipeline: planner → DAG → reflection.
   * Most expensive path, used only when genuinely needed.
   */
  private async handleComplex(
    task: TaskRecord,
    relevantMemories: string[],
    memoryManager: ReturnType<typeof getMemoryManager>
  ): Promise<void> {
    // Planning phase (LLM call to decompose)
    const plan = await this.planner.decompose(task.id, task.prompt)
    task.plan = plan

    this.db.run(
      `UPDATE tasks SET plan = ?, assigned_agent = 'orchestrator' WHERE id = ?`,
      JSON.stringify(plan),
      task.id
    )

    // Execution phase — run the DAG
    task.status = 'in_progress'
    this.db.run(`UPDATE tasks SET status = 'in_progress', started_at = CURRENT_TIMESTAMP WHERE id = ?`, task.id)

    const results = await this.executePlan(task, plan, relevantMemories)
    if (task.status === 'cancelled') return

    const finalResult = this.compileResults(plan, results)
    await this.completeTask(task, finalResult, plan, memoryManager)

    // Auto-reflect (async, non-blocking)
    this.triggerReflection(task, plan, results).catch((err) => {
      console.warn('[Orchestrator] Reflection failed:', err)
    })
  }

  /** Shared completion logic for direct and complex lanes */
  private async completeTask(
    task: TaskRecord,
    result: unknown,
    plan: TaskPlan,
    memoryManager: ReturnType<typeof getMemoryManager>
  ): Promise<void> {
    task.status = 'completed'
    task.result = result
    task.completedAt = Date.now()

    this.db.run(
      `UPDATE tasks SET status = 'completed', result = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      JSON.stringify(result),
      task.id
    )

    this.bus.emitEvent('task:completed', { taskId: task.id, result })

    // Store experience as episodic memory
    try {
      await memoryManager.storeEpisodic({
        content: `Task completed: "${task.prompt.slice(0, 200)}". Result: ${JSON.stringify(result).slice(0, 500)}`,
        source: 'orchestrator',
        importance: task.priority === 'high' ? 0.8 : task.priority === 'normal' ? 0.5 : 0.3,
        emotionalValence: 0.6,
        tags: ['task-completed', `priority-${task.priority}`],
        participants: ['orchestrator', ...plan.requiredAgents],
      })
    } catch (err) {
      console.warn('[Orchestrator] Failed to store task memory:', err)
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
