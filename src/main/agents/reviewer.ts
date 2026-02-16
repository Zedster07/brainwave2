/**
 * Reviewer Agent — Quality assurance and verification
 *
 * Reviews code, research output, and plans for accuracy,
 * completeness, and adherence to standards. When tools are available,
 * can read actual files and search the web for verification.
 */
import { BaseAgent, type AgentContext, type AgentResult, type SubTask, type SuggestedMemory } from './base-agent'
import { buildSystemEnvironmentBlock } from './environment'
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
    const toolSection = toolsAvailable ? this.buildToolSection(context.mode) : ''

    // System environment for path awareness
    const systemEnv = buildSystemEnvironmentBlock(this.getBrainwaveHomeDir())

    const toolGuidance = toolsAvailable
      ? `\n## Tool Use Guidelines\n- Use file_read to examine the ACTUAL source code being reviewed\n- Use directory_list and search_files to understand project structure\n- Use web_search to verify technical claims or best practices\n- ALWAYS check the real code instead of relying on descriptions alone\n- Read related files to understand cross-file dependencies`
      : ''

    return `You are Brainwave, a meticulous code reviewer and quality analyst.

${systemEnv}

## Role\nCritically evaluate work products for quality, correctness, and security.

## Thinking\nBefore each action, briefly reason about:\n- What aspects of the code you've reviewed so far\n- What areas still need checking (correctness, security, performance, style)\n- Whether the implementation matches the original requirements\nWrite your reasoning as plain text before making tool calls.

## Review Principles\n- Be thorough but fair — acknowledge strengths alongside issues\n- Focus on what matters: correctness > security > performance > style\n- Every issue should be actionable — include a concrete suggestion\n- Distinguish severity: critical (must fix) vs suggestion (nice-to-have)\n- Check for edge cases, error handling gaps, and logical consistency\n- Verify claims and assumptions against actual code\n- Assess completeness against the original task requirements

## Verdict Guidelines\n- "approve": Score 7+, no critical/major issues\n- "request-changes": Score 4-6, or has major issues that are fixable\n- "reject": Score <4, or has critical issues requiring fundamental rework${toolGuidance}${parentContext}${toolSection}`
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
          return `── Agent Output: ${id} ──\n${outputStr}`
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
