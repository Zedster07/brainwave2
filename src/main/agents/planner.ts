/**
 * Planner Agent — Task decomposition expert
 *
 * Takes a high-level task and produces a DAG of sub-tasks.
 * Maximizes parallelism by identifying independent tasks.
 */
import { randomUUID } from 'crypto'
import { BaseAgent, type AgentContext, type AgentResult, type SubTask, type TaskPlan } from './base-agent'
import type { AgentType } from './event-bus'
import type { LLMResponse } from '../llm'

// ─── Planner Output Schema ─────────────────────────────────

interface PlannerOutput {
  complexity: 'trivial' | 'simple' | 'moderate' | 'complex' | 'epic'
  subtasks: Array<{
    id: string
    description: string
    agent: AgentType
    dependsOn: string[]
    maxAttempts?: number
  }>
  reasoning: string
}

// ─── Planner Agent ──────────────────────────────────────────

export class PlannerAgent extends BaseAgent {
  readonly type = 'planner' as const
  readonly capabilities = ['task-decomposition', 'dependency-analysis', 'estimation']
  readonly description = 'Decomposes complex tasks into executable sub-task DAGs'

  protected getSystemPrompt(context: AgentContext): string {
    return `You are the Planner Agent in the Brainwave system.

Your role: Decompose tasks into a clear, executable plan of sub-tasks.

RULES:
1. Each sub-task must be assignable to exactly ONE agent type
2. Identify dependencies between sub-tasks (which must finish before others can start)
3. Maximize parallelism — independent tasks should have no dependencies between them
4. Estimate overall complexity: trivial, simple, moderate, complex, or epic
5. Keep sub-tasks atomic — each should be completable by a single agent in one pass

AVAILABLE AGENT TYPES:
- researcher: Web search, documentation lookup, fact-finding, summarization
- coder: Code generation, modification, debugging, explanation
- reviewer: Quality checking, code review, accuracy verification
- reflection: Post-task analysis and lesson extraction

IMPORTANT:
- For simple tasks that don't need decomposition, create a single sub-task
- Always include a unique ID for each sub-task (use short descriptive IDs like "research-api", "code-model")
- dependsOn should reference other sub-task IDs (empty array [] if no dependencies)
- Never make circular dependencies

OUTPUT FORMAT (JSON):
{
  "complexity": "simple",
  "reasoning": "Brief explanation of the decomposition strategy",
  "subtasks": [
    {
      "id": "step-1",
      "description": "Clear description of what to do",
      "agent": "researcher",
      "dependsOn": [],
      "maxAttempts": 2
    }
  ]
}`
  }

  /** Decompose a task into a TaskPlan */
  async decompose(taskId: string, prompt: string, memories?: string[]): Promise<TaskPlan> {
    const context: AgentContext = {
      taskId,
      relevantMemories: memories,
    }

    const { parsed, raw } = await this.thinkJSON<PlannerOutput>(
      `Decompose this task into sub-tasks:\n\n"${prompt}"`,
      context,
      { temperature: 0.4 }
    )

    const plan: TaskPlan = {
      id: `plan_${randomUUID().slice(0, 8)}`,
      taskId,
      originalTask: prompt,
      subTasks: parsed.subtasks.map((st) => ({
        id: st.id,
        description: st.description,
        assignedAgent: st.agent,
        status: 'pending' as const,
        dependencies: st.dependsOn,
        attempts: 0,
        maxAttempts: st.maxAttempts ?? 2,
      })),
      estimatedComplexity: parsed.complexity,
      requiredAgents: [...new Set(parsed.subtasks.map((st) => st.agent))],
    }

    this.bus.emitEvent('plan:created', {
      taskId,
      planId: plan.id,
      steps: plan.subTasks.length,
      agents: plan.requiredAgents,
    })

    // Log confidence and cost
    this.bus.emitEvent('agent:completed', {
      agentType: this.type,
      taskId,
      confidence: this.assessConfidence(raw),
      tokensIn: raw.tokensIn,
      tokensOut: raw.tokensOut,
    })

    return plan
  }

  /** Assess confidence — planners need higher bar */
  protected assessConfidence(response: LLMResponse): number {
    if (response.finishReason === 'stop') return 0.8
    if (response.finishReason === 'length') return 0.3
    return 0.5
  }
}
