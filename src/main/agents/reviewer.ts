/**
 * Reviewer Agent — Quality assurance and verification
 *
 * Reviews code, research output, and plans for accuracy,
 * completeness, and adherence to standards. When tools are available,
 * can read actual files and search the web for verification.
 */
import { BaseAgent, type AgentContext, type AgentResult, type SubTask, type SuggestedMemory } from './base-agent'
import { hasToolAccess } from '../tools/permissions'
import type { LLMResponse } from '../llm'

// ─── Review Output Schema ──────────────────────────────────

interface ReviewOutput {
  verdict: 'approve' | 'request-changes' | 'reject'
  summary: string
  overallScore: number  // 0-10
  issues: Array<{
    severity: 'critical' | 'major' | 'minor' | 'suggestion'
    category: 'correctness' | 'security' | 'performance' | 'style' | 'completeness' | 'logic'
    description: string
    location?: string
    suggestion?: string
  }>
  strengths: string[]
  suggestedMemories?: Array<{
    type: 'semantic'
    content: string
    importance: number
    tags: string[]
  }>
}

// ─── Reviewer Agent ─────────────────────────────────────────

export class ReviewerAgent extends BaseAgent {
  readonly type = 'reviewer' as const
  readonly capabilities = [
    'code-review',
    'quality-assessment',
    'accuracy-verification',
    'security-review',
    'completeness-check',
  ]
  readonly description = 'Reviews outputs for quality, correctness, security, and completeness'

  protected getSystemPrompt(context: AgentContext): string {
    const parentContext = context.parentTask
      ? `\n\nORIGINAL TASK: "${context.parentTask}"`
      : ''

    const toolsAvailable = hasToolAccess(this.type)
    const toolSection = toolsAvailable ? this.buildToolSection() : ''

    const toolGuidance = toolsAvailable
      ? `\n\nTOOL USAGE:
You HAVE tools available — use them to verify claims and check actual code.
- Use file_read to examine the actual source code being reviewed
- Use directory_list to understand project structure
- Use web_search to verify technical claims or best practices
- ALWAYS check the real code instead of relying on descriptions alone
- When review is complete, provide your assessment with { "done": true, "summary": "..." }`
      : ''

    return `You are the Reviewer Agent in the Brainwave system.

Your role: Critically evaluate work products for quality, correctness, and security.

REVIEW PRINCIPLES:
1. Be thorough but fair — acknowledge strengths alongside issues
2. Focus on what matters: correctness > security > performance > style
3. Every issue should be actionable — include a concrete suggestion
4. Distinguish severity levels (critical = must fix, suggestion = nice-to-have)
5. Check for logical consistency across the full output
6. Verify claims and assumptions when possible
7. Check for edge cases and error handling gaps
8. Assess completeness against the original task requirements

VERDICT GUIDELINES:
- "approve": Score 7+, no critical/major issues
- "request-changes": Score 4-6, or has major issues that are fixable
- "reject": Score <4, or has critical issues that require fundamental rework

OUTPUT FORMAT (JSON):
{
  "verdict": "approve",
  "summary": "Brief overall assessment",
  "overallScore": 8,
  "issues": [
    {
      "severity": "minor",
      "category": "style",
      "description": "What's wrong",
      "location": "Where it is (file, line, section)",
      "suggestion": "How to fix it"
    }
  ],
  "strengths": ["What was done well"],
  "suggestedMemories": [
    {
      "type": "semantic",
      "content": "Pattern or anti-pattern worth remembering",
      "importance": 0.6,
      "tags": ["review-lesson"]
    }
  ]
}${toolGuidance}${parentContext}${toolSection}`
  }

  /** Execute review — uses tools when available, structured JSON fallback otherwise */
  async execute(task: SubTask, context: AgentContext): Promise<AgentResult> {
    if (hasToolAccess(this.type)) {
      return this.executeWithTools(task, context)
    }
    return this.executeStructured(task, context)
  }

  /** Original structured review execution (no tools) */
  private async executeStructured(task: SubTask, context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now()

    try {
      const query = this.buildQuery(task, context)

      const { parsed, raw } = await this.thinkJSON<ReviewOutput>(
        query,
        context,
        { temperature: 0.2, maxTokens: 4096 }
      )

      const suggestedMemories: SuggestedMemory[] = (parsed.suggestedMemories ?? []).map((m) => ({
        type: 'semantic' as const,
        content: m.content,
        importance: m.importance,
        tags: m.tags,
      }))

      const confidence = this.assessReviewConfidence(parsed, raw)

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
        status: parsed.verdict === 'reject' ? 'partial' : 'success',
        output: parsed,
        confidence,
        reasoning: parsed.summary,
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
    let query = `Review the following:\n\n"${task.description}"`

    // Include all sibling results — this is what the reviewer checks
    if (context.siblingResults && context.siblingResults.size > 0) {
      const outputs = [...context.siblingResults.entries()]
        .filter(([, result]) => result.status === 'success' || result.status === 'partial')
        .map(([id, result]) => {
          const outputStr = typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output, null, 2)
          return `── Agent Output: ${id} ──\n${outputStr.slice(0, 3000)}`
        })
        .join('\n\n')

      if (outputs) {
        query += `\n\nWORK TO REVIEW:\n${outputs}`
      }
    }

    return query
  }

  private assessReviewConfidence(output: ReviewOutput, response: LLMResponse): number {
    let conf = response.finishReason === 'stop' ? 0.7 : 0.4

    // More detailed reviews → higher confidence
    if (output.issues.length > 0) conf += 0.05
    if (output.strengths.length > 0) conf += 0.05

    // Score alignment with verdict
    if (
      (output.verdict === 'approve' && output.overallScore >= 7) ||
      (output.verdict === 'request-changes' && output.overallScore >= 4 && output.overallScore < 7) ||
      (output.verdict === 'reject' && output.overallScore < 4)
    ) {
      conf += 0.1 // Consistent verdict and score
    }

    return Math.min(1, conf)
  }
}
