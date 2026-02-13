/**
 * Researcher Agent — Information gatherer and synthesizer
 *
 * Searches the web, reads docs, queries knowledge bases,
 * and produces structured research summaries with citations.
 */
import { BaseAgent, type AgentContext, type AgentResult, type SubTask, type SuggestedMemory, type Artifact } from './base-agent'
import type { LLMResponse } from '../llm'

// ─── Research Output Schema ────────────────────────────────

interface ResearchOutput {
  summary: string
  findings: Array<{
    claim: string
    confidence: number
    sources?: string[]
  }>
  followUpQuestions?: string[]
  suggestedMemories?: Array<{
    type: 'episodic' | 'semantic'
    content: string
    importance: number
    tags: string[]
  }>
}

// ─── Researcher Agent ───────────────────────────────────────

export class ResearcherAgent extends BaseAgent {
  readonly type = 'researcher' as const
  readonly capabilities = [
    'web-search',
    'fact-finding',
    'summarization',
    'source-verification',
    'knowledge-synthesis',
  ]
  readonly description = 'Searches for information, synthesizes knowledge, and provides cited answers'

  protected getSystemPrompt(context: AgentContext): string {
    const parentContext = context.parentTask
      ? `\n\nPARENT TASK: "${context.parentTask}"`
      : ''

    return `You are the Researcher Agent in the Brainwave system.

Your role: Find accurate, relevant information and synthesize it clearly.

IMPORTANT: You do NOT have access to the internet or web search tools.
You can only use your training knowledge. If the user's question requires
live/current web data, state that clearly in your summary and suggest
the Executor agent be used with the web_search tool instead.

PRINCIPLES:
1. Always strive for accuracy — prefer being uncertain over being wrong
2. Cite sources when available (URLs, document names, etc.)
3. Cross-reference claims when possible — note conflicting information
4. Flag information that may be outdated or unverified
5. Summarize findings in a structured, easy-to-consume format
6. Suggest follow-up questions when the topic warrants deeper exploration
7. When you find facts worth remembering, suggest them as memories

OUTPUT FORMAT (JSON):
{
  "summary": "Clear, concise summary of findings",
  "findings": [
    {
      "claim": "Specific factual claim or finding",
      "confidence": 0.9,
      "sources": ["URL or reference"]
    }
  ],
  "followUpQuestions": ["Optional related questions worth exploring"],
  "suggestedMemories": [
    {
      "type": "semantic",
      "content": "Key fact or knowledge to remember",
      "importance": 0.7,
      "tags": ["topic-tag"]
    }
  ]
}

Be thorough but concise. Quality over quantity.${parentContext}`
  }

  /** Execute research task with structured output */
  async execute(task: SubTask, context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now()

    try {
      // Build the research query with sibling context
      const query = this.buildQuery(task, context)

      const { parsed, raw } = await this.thinkJSON<ResearchOutput>(
        query,
        context,
        { temperature: 0.5, maxTokens: 4096 }
      )

      // Extract suggested memories
      const suggestedMemories: SuggestedMemory[] = (parsed.suggestedMemories ?? []).map((m) => ({
        type: m.type === 'semantic' ? 'semantic' : 'episodic',
        content: m.content,
        importance: m.importance,
        tags: m.tags,
      }))

      // Create text artifact with the full research summary
      const artifacts: Artifact[] = [{
        type: 'text',
        name: 'research-summary',
        content: this.formatSummary(parsed),
      }]

      const confidence = this.assessResearchConfidence(parsed, raw)

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
        artifacts,
      })

      return {
        status: 'success',
        output: parsed,
        confidence,
        reasoning: parsed.summary,
        tokensIn: raw.tokensIn,
        tokensOut: raw.tokensOut,
        model: raw.model,
        suggestedMemories,
        artifacts,
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
    let query = `Research the following:\n\n"${task.description}"`

    // Include sibling results for context
    if (context.siblingResults && context.siblingResults.size > 0) {
      const siblingContext = [...context.siblingResults.entries()]
        .map(([id, result]) => `[${id}]: ${JSON.stringify(result.output).slice(0, 300)}`)
        .join('\n')
      query += `\n\nCONTEXT FROM OTHER AGENTS:\n${siblingContext}`
    }

    return query
  }

  private formatSummary(output: ResearchOutput): string {
    let text = `## Research Summary\n\n${output.summary}\n\n### Findings\n`

    for (const finding of output.findings) {
      const conf = `(${(finding.confidence * 100).toFixed(0)}% confident)`
      const sources = finding.sources?.length ? ` — Sources: ${finding.sources.join(', ')}` : ''
      text += `\n- ${finding.claim} ${conf}${sources}`
    }

    if (output.followUpQuestions?.length) {
      text += `\n\n### Follow-up Questions\n`
      for (const q of output.followUpQuestions) {
        text += `\n- ${q}`
      }
    }

    return text
  }

  private assessResearchConfidence(output: ResearchOutput, response: LLMResponse): number {
    // Average confidence of findings, weighted by base confidence
    const baseConf = response.finishReason === 'stop' ? 0.6 : 0.3

    if (output.findings.length === 0) return baseConf * 0.5

    const avgFindingConf = output.findings.reduce((sum, f) => sum + f.confidence, 0) / output.findings.length
    const hasSources = output.findings.some((f) => f.sources && f.sources.length > 0)

    return Math.min(1, baseConf + avgFindingConf * 0.3 + (hasSources ? 0.1 : 0))
  }

  /** Log the agent run to DB */
  private logRun(task: SubTask, context: AgentContext, result: AgentResult): void {
    try {
      const { randomUUID } = require('crypto')
      this.db.run(
        `INSERT INTO agent_runs (id, agent_type, task_id, status, input, output, llm_model, tokens_in, tokens_out, cost_usd, confidence, prompt_version, started_at, completed_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), CURRENT_TIMESTAMP, ?)`,
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
        result.promptVersion ?? null,
        `-${result.duration / 1000} seconds`,
        result.error ?? null
      )
    } catch (err) {
      console.error(`[${this.type}] Failed to log run:`, err)
    }
  }
}
