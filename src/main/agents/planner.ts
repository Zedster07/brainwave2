/**
 * Planner Agent — Task decomposition expert with project reconnaissance
 *
 * Takes a high-level task and produces a DAG of sub-tasks.
 * Maximizes parallelism by identifying independent tasks.
 * Can read project files/structure before planning for context-aware decomposition.
 * Outputs a user-visible task list for progress tracking.
 */
import { randomUUID } from 'crypto'
import { BaseAgent, type AgentContext, type AgentResult, type SubTask, type TaskPlan } from './base-agent'
import { buildSystemEnvironmentBlock } from './environment'
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
    /** Human-readable title for the task list UI (short, ~5-10 words) */
    title?: string
  }>
  reasoning: string
}

// ─── Planner Agent ──────────────────────────────────────────

export class PlannerAgent extends BaseAgent {
  readonly type = 'planner' as const
  readonly capabilities = ['task-decomposition', 'dependency-analysis', 'estimation', 'project-reconnaissance']
  readonly description = 'Decomposes complex tasks into executable sub-task DAGs with project context awareness'

  protected getSystemPrompt(context: AgentContext): string {
    const toolSection = this.buildToolSection(context.mode)

    // Gather real system context so the planner never guesses paths
    const brainwaveHomeDir = this.getBrainwaveHomeDir()
    const systemEnv = buildSystemEnvironmentBlock(brainwaveHomeDir)

    return `You are Brainwave, an expert software architect and project planner. You decompose complex tasks into clear, executable plans of sub-tasks, maximizing parallelism and identifying dependencies.

${systemEnv}

ALWAYS use these REAL paths when exploring files/directories during reconnaissance.
On Windows, use backslash paths (e.g. "C:\\Users\\...") or forward slashes.
NEVER guess paths like "/workspace/" — use directory_list with the real paths above.

## Thinking
Before acting, reason through:
- What is the user actually asking for? What is the end goal?
- What files/structure do I need to examine to plan accurately?
- How can I break this into independent, parallelizable steps?
- What are the dependencies between steps?
- Which agent type is best suited for each step?

## RECONNAISSANCE
Before creating your plan, you have access to tools (file_read, directory_list) to explore the project structure.
Use these to understand:
- Project type (package.json, requirements.txt, etc.)
- Directory structure (what folders/files exist)
- Key configuration files (tsconfig, vite.config, etc.)
- Existing code patterns and conventions

Read at most 3-5 files to get enough context, then produce your plan.

## PLANNING RULES
1. Each sub-task must be assignable to exactly ONE agent type
2. Identify dependencies between sub-tasks (which must finish before others can start)
3. Maximize parallelism — independent tasks should have no dependencies between them
4. Estimate overall complexity: trivial, simple, moderate, complex, or epic
5. Keep sub-tasks atomic — each should be completable by a single agent in one pass
6. Give each subtask a short human-readable "title" for the progress UI (5-10 words)

## AVAILABLE AGENT TYPES
- researcher: Web search, documentation lookup, fact-finding, summarization
- coder: Code generation, modification, debugging — can read/write/edit files directly, but CANNOT run shell commands
- writer: Creative writing, documentation, content generation, blog posts
- analyst: Data analysis, pattern recognition, strategic reasoning
- critic: Critical evaluation, argument analysis, quality assessment
- reviewer: Code review, accuracy verification, quality checking (read-only access)
- executor: FULL LOCAL COMPUTER ACCESS — can read/write/create/delete/move files, list directories, execute shell commands (git, npm, python, node, etc.), and make HTTP requests. Use for ANY file system, command-line, build, install, or network task.

## IMPORTANT
- For coding tasks, prefer "coder" for writing/editing code and "executor" for running commands (npm install, build, git, etc.)
- If a task needs BOTH writing code AND running commands, split into coder step → executor step
- For simple tasks that don't need decomposition, create a single sub-task
- Always include a unique ID for each sub-task (use short descriptive IDs like "research-api", "code-model")
- dependsOn should reference other sub-task IDs (empty array [] if no dependencies)
- Never make circular dependencies

## OUTPUT FORMAT
When you have finished reconnaissance and are ready to plan, signal completion:
<attempt_completion>
<result>
<JSON plan>
</result>
</attempt_completion>

The JSON plan inside the result must be:
{
  "complexity": "simple",
  "reasoning": "Brief explanation of the decomposition strategy",
  "subtasks": [
    {
      "id": "step-1",
      "title": "Research the API docs",
      "description": "Detailed description of what to do...",
      "agent": "researcher",
      "dependsOn": [],
      "maxAttempts": 2
    }
  ]
}${toolSection}`
  }

  /** Decompose a task into a TaskPlan */
  async decompose(taskId: string, prompt: string, memories?: string[], conversationHistory?: Array<{ role: string; content: string }>): Promise<TaskPlan> {
    console.log(`[Planner] decompose() called | taskId=${taskId} | prompt="${prompt.slice(0, 100)}"`)

    const context: AgentContext = {
      taskId,
      relevantMemories: memories,
      conversationHistory,
    }

    // Try tool-based execution first (with reconnaissance)
    let parsed: PlannerOutput
    let raw: LLMResponse

    const result = await this.executeWithTools(
      {
        id: `plan-${taskId}`,
        description: `Decompose this task into sub-tasks:\n\n"${prompt}"`,
        assignedAgent: 'planner',
        status: 'pending',
        dependencies: [],
        attempts: 0,
        maxAttempts: 1,
      },
      context
    )

    // Parse the plan from the result output
    const outputStr = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)

    try {
      // Try to extract JSON from the output (it may be wrapped in text)
      const jsonMatch = outputStr.match(/\{[\s\S]*"subtasks"[\s\S]*\}/)
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0])
      } else {
        // Fall back to thinkJSON if tool-based approach didn't produce structured output
        const jsonResult = await this.thinkJSON<PlannerOutput>(
          `Decompose this task into sub-tasks:\n\n"${prompt}"`,
          context,
          { temperature: 0.4 }
        )
        parsed = jsonResult.parsed
        raw = jsonResult.raw
      }
    } catch {
      // Final fallback — ask directly without tools
      const jsonResult = await this.thinkJSON<PlannerOutput>(
        `Decompose this task into sub-tasks:\n\n"${prompt}"`,
        context,
        { temperature: 0.4 }
      )
      parsed = jsonResult.parsed
      raw = jsonResult.raw
    }

    // @ts-expect-error — raw may be undefined if tool-based path succeeded
    const rawResponse = raw ?? { tokensIn: result.tokensIn, tokensOut: result.tokensOut, finishReason: 'stop', model: result.model, content: outputStr }

    // Guard: ensure parsed output has valid subtasks array
    if (!parsed?.subtasks || !Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
      throw new Error(`Planner output missing valid subtasks array. Got: ${JSON.stringify(parsed).slice(0, 200)}`)
    }

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
        // Store the human-readable title for the task list
        title: st.title ?? st.description,
      })),
      estimatedComplexity: parsed.complexity ?? 'medium',
      requiredAgents: [...new Set(parsed.subtasks.map((st) => st.agent))],
    }

    console.log(`[Planner] Plan created: ${plan.id} | complexity=${parsed.complexity} | ${plan.subTasks.length} subtask(s): ${plan.subTasks.map(s => `${s.id}(${s.assignedAgent})`).join(', ')}`)

    this.bus.emitEvent('plan:created', {
      taskId,
      planId: plan.id,
      steps: plan.subTasks.length,
      agents: plan.requiredAgents,
    })

    // Emit the task list for UI progress tracking
    this.bus.emitEvent('plan:task-list', {
      taskId,
      planId: plan.id,
      items: plan.subTasks.map((st) => ({
        id: st.id,
        title: (st as SubTask & { title?: string }).title ?? st.description,
        agent: st.assignedAgent,
        status: 'pending' as const,
        dependsOn: st.dependencies,
      })),
    })

    // Log confidence and cost
    this.bus.emitEvent('agent:completed', {
      agentType: this.type,
      taskId,
      confidence: this.assessConfidence(rawResponse),
      tokensIn: rawResponse.tokensIn,
      tokensOut: rawResponse.tokensOut,
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
