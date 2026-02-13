/**
 * Reflection Agent — Post-task analysis, learning, and rule proposal
 *
 * Analyzes completed tasks to extract lessons, patterns, and anti-patterns.
 * Proposes new behavioral rules when it detects recurring patterns.
 * Stores learnings as semantic memories for future recall.
 */
import { BaseAgent, type AgentContext, type AgentResult, type SubTask, type SuggestedMemory } from './base-agent'
import { getMemoryManager } from '../memory'
import { getSoftEngine } from '../rules'
import type { LLMResponse } from '../llm'

// ─── Reflection Output Schema ──────────────────────────────

interface ReflectionOutput {
  taskSummary: string
  lessonsLearned: Array<{
    lesson: string
    category: 'success-pattern' | 'failure-pattern' | 'preference' | 'optimization' | 'context'
    importance: number   // 0-1
    confidence: number   // 0-1
    tags: string[]
  }>
  proposedRules: Array<{
    rule: string
    category: 'behavioral' | 'quality' | 'routing' | 'memory' | 'escalation' | 'cost'
    confidence: number
    rationale: string
    appliesTo?: string[]
  }>
  performanceNotes: {
    whatWorkedWell: string[]
    whatCouldImprove: string[]
    agentPerformance: Array<{
      agent: string
      score: number   // 0-10
      note: string
    }>
  }
  overallTaskQuality: number  // 0-10
}

// ─── Reflection Agent ───────────────────────────────────────

export class ReflectionAgent extends BaseAgent {
  readonly type = 'reflection' as const
  readonly capabilities = [
    'task-analysis',
    'lesson-extraction',
    'pattern-detection',
    'rule-proposal',
    'performance-assessment',
  ]
  readonly description = 'Analyzes completed tasks, extracts lessons, and proposes behavioral rules'

  protected getSystemPrompt(_context: AgentContext): string {
    return `You are the Reflection Agent in the Brainwave system.

Your role: Analyze completed tasks to learn and improve the system over time.

RESPONSIBILITIES:
1. Extract concrete, actionable lessons from task outcomes
2. Identify success patterns (what went well and should be repeated)
3. Identify failure patterns (what went wrong and should be avoided)
4. Detect user preferences and working style patterns
5. Propose new behavioral rules when you see recurring patterns
6. Assess agent performance for future task routing optimization

LESSON CATEGORIES:
- success-pattern: An approach that worked well and should be repeated
- failure-pattern: An approach that failed and should be avoided
- preference: A user preference or working style observation
- optimization: A way to do things faster, cheaper, or better
- context: Important context about the project, domain, or environment

RULE PROPOSAL GUIDELINES:
- Only propose rules when you're confident (>0.7) they would help
- Rules should be general enough to apply beyond the current task
- Include your rationale for why this rule would be beneficial
- Categories: behavioral, quality, routing, memory, escalation, cost

OUTPUT FORMAT (JSON):
{
  "taskSummary": "What was the task and what happened",
  "lessonsLearned": [
    {
      "lesson": "Concrete, actionable lesson statement",
      "category": "success-pattern",
      "importance": 0.7,
      "confidence": 0.8,
      "tags": ["relevant-tags"]
    }
  ],
  "proposedRules": [
    {
      "rule": "Clear, actionable rule statement",
      "category": "quality",
      "confidence": 0.8,
      "rationale": "Why this rule would help",
      "appliesTo": ["coder", "reviewer"]
    }
  ],
  "performanceNotes": {
    "whatWorkedWell": ["Specific things"],
    "whatCouldImprove": ["Specific things"],
    "agentPerformance": [
      { "agent": "researcher", "score": 8, "note": "Thorough research" }
    ]
  },
  "overallTaskQuality": 7
}

Be honest and specific. Vague lessons like "be better" are useless.
Focus on concrete, actionable insights that can improve future performance.`
  }

  /** Execute reflection on a completed task */
  async execute(task: SubTask, context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now()

    try {
      const query = this.buildQuery(task, context)

      const { parsed, raw } = await this.thinkJSON<ReflectionOutput>(
        query,
        context,
        { temperature: 0.4, maxTokens: 4096 }
      )

      // Store lessons as semantic memories
      const suggestedMemories: SuggestedMemory[] = []
      const memoryManager = getMemoryManager()

      for (const lesson of parsed.lessonsLearned) {
        if (lesson.confidence >= 0.5 && lesson.importance >= 0.4) {
          // Store directly as semantic memory
          try {
            await memoryManager.storeSemantic({
              subject: `lesson:${lesson.category}`,
              predicate: 'learned_that',
              object: lesson.lesson,
              confidence: lesson.confidence,
              source: 'reflection',
              tags: ['reflection', lesson.category, ...lesson.tags],
            })
          } catch (err) {
            console.warn('[Reflection] Failed to store lesson memory:', err)
          }

          suggestedMemories.push({
            type: 'semantic',
            content: lesson.lesson,
            importance: lesson.importance,
            tags: ['reflection', lesson.category, ...lesson.tags],
          })
        }
      }

      // Submit rule proposals to the Soft Engine
      const softEngine = getSoftEngine()
      for (const proposal of parsed.proposedRules) {
        if (proposal.confidence >= 0.7) {
          softEngine.proposeRule({
            suggestedRule: proposal.rule,
            category: proposal.category,
            evidence: [context.taskId],
            confidence: proposal.confidence,
            appliesTo: proposal.appliesTo as import('../agents/event-bus').AgentType[] | undefined,
          })
        }
      }

      // Store the reflection itself as episodic memory
      try {
        await memoryManager.storeEpisodic({
          content: `Reflection on task "${context.parentTask?.slice(0, 100)}": Quality ${parsed.overallTaskQuality}/10. ${parsed.taskSummary}`,
          source: 'reflection',
          importance: 0.6,
          emotionalValence: parsed.overallTaskQuality >= 7 ? 0.7 : parsed.overallTaskQuality >= 4 ? 0.4 : 0.2,
          tags: ['reflection', 'task-review'],
          participants: parsed.performanceNotes.agentPerformance.map((a) => a.agent),
        })
      } catch (err) {
        console.warn('[Reflection] Failed to store reflection memory:', err)
      }

      const confidence = this.assessReflectionConfidence(parsed, raw)

      this.bus.emitEvent('agent:completed', {
        agentType: this.type,
        taskId: context.taskId,
        confidence,
        tokensIn: raw.tokensIn,
        tokensOut: raw.tokensOut,
      })

      this.logRun(task, context, {
        status: 'success',
        output: parsed,
        confidence,
        tokensIn: raw.tokensIn,
        tokensOut: raw.tokensOut,
        model: raw.model,
        duration: Date.now() - startTime,
        suggestedMemories,
      })

      return {
        status: 'success',
        output: parsed,
        confidence,
        reasoning: parsed.taskSummary,
        tokensIn: raw.tokensIn,
        tokensOut: raw.tokensOut,
        model: raw.model,
        suggestedMemories,
        duration: Date.now() - startTime,
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)

      this.bus.emitEvent('agent:error', {
        agentType: this.type,
        taskId: context.taskId,
        error,
      })

      return {
        status: 'failed',
        output: null,
        confidence: 0,
        error,
        tokensIn: 0,
        tokensOut: 0,
        model: 'unknown',
        duration: Date.now() - startTime,
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────

  private buildQuery(task: SubTask, context: AgentContext): string {
    let query = `Reflect on this completed task:\n\n"${task.description}"`

    if (context.parentTask) {
      query += `\n\nOriginal user request: "${context.parentTask}"`
    }

    // Include all sibling results — this is what we're reflecting on
    if (context.siblingResults && context.siblingResults.size > 0) {
      const outputs = [...context.siblingResults.entries()]
        .map(([id, result]) => {
          const statusEmoji = result.status === 'success' ? '✓' : result.status === 'partial' ? '~' : '✗'
          const outputStr = typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output, null, 2)
          return `${statusEmoji} [${id}] (confidence: ${result.confidence.toFixed(2)}, tokens: ${result.tokensIn + result.tokensOut})\n${outputStr.slice(0, 2000)}`
        })
        .join('\n\n')

      query += `\n\nTASK EXECUTION RESULTS:\n${outputs}`
    }

    return query
  }

  private assessReflectionConfidence(output: ReflectionOutput, response: LLMResponse): number {
    let conf = response.finishReason === 'stop' ? 0.7 : 0.4

    // More lessons → more thorough reflection
    if (output.lessonsLearned.length >= 2) conf += 0.1

    // Performance notes show careful analysis
    if (output.performanceNotes.agentPerformance.length > 0) conf += 0.05

    return Math.min(1, conf)
  }

  private logRun(task: SubTask, context: AgentContext, result: AgentResult): void {
    try {
      const { randomUUID } = require('crypto')
      this.db.run(
        `INSERT INTO agent_runs (id, agent_type, task_id, status, input, output, llm_model, tokens_in, tokens_out, cost_usd, confidence, started_at, completed_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), CURRENT_TIMESTAMP, ?)`,
        randomUUID(),
        this.type,
        context.taskId,
        result.status === 'success' ? 'completed' : 'failed',
        JSON.stringify({ description: task.description }),
        JSON.stringify(result.output),
        result.model,
        result.tokensIn,
        result.tokensOut,
        0,
        result.confidence,
        `-${result.duration / 1000} seconds`,
        result.error ?? null
      )
    } catch (err) {
      console.error(`[${this.type}] Failed to log run:`, err)
    }
  }
}
