/**
 * Coder Agent — Code generation, modification, and explanation
 *
 * Writes clean, well-structured code following project conventions.
 * When tools are available, can read/write actual files and search docs.
 * Falls back to structured JSON output when tools aren't available.
 */
import os from 'os'
import { BaseAgent, type AgentContext, type AgentResult, type SubTask, type Artifact, type SuggestedMemory } from './base-agent'
import { hasToolAccess } from '../tools/permissions'
import type { LLMResponse } from '../llm'

// ─── Coder Output Schema ───────────────────────────────────

interface CoderOutput {
  explanation: string
  code?: string
  language?: string
  filename?: string
  changes?: Array<{
    file: string
    action: 'create' | 'modify' | 'delete'
    description: string
    code?: string
    language?: string
  }>
  testSuggestions?: string[]
  suggestedMemories?: Array<{
    type: 'semantic'
    content: string
    importance: number
    tags: string[]
  }>
}

// ─── Coder Agent ────────────────────────────────────────────

export class CoderAgent extends BaseAgent {
  readonly type = 'coder' as const
  readonly capabilities = [
    'code-generation',
    'code-modification',
    'debugging',
    'refactoring',
    'code-explanation',
    'architecture',
  ]
  readonly description = 'Generates, modifies, debugs, and explains code with best practices'

  protected getSystemPrompt(context: AgentContext): string {
    const parentContext = context.parentTask
      ? `\n\nPARENT TASK: "${context.parentTask}"`
      : ''

    const toolsAvailable = hasToolAccess(this.type)
    const toolSection = toolsAvailable ? this.buildToolSection() : ''

    const toolGuidance = toolsAvailable
      ? `\n\nTOOL USAGE:
You HAVE tools available — use them to work with real files.
- Use file_read to examine existing code before modifying
- Use directory_list to understand project structure
- Use file_write / file_create to write code to actual files
- Use web_search / webpage_fetch to look up documentation
- ALWAYS read existing code before proposing changes
- When you are done, provide your final summary with { "done": true, "summary": "..." }`
      : ''

    // System environment for path awareness
    const homeDir = os.homedir()
    const platform = os.platform()
    const brainwaveHomeDir = this.getBrainwaveHomeDir()

    const systemEnv = `
## System Environment
- Platform: ${platform} (${os.arch()})
- OS User Home: ${homeDir}
- **YOUR Home Directory (Brainwave Home): ${brainwaveHomeDir}**
- Shell working directory (CWD): ${process.cwd()}

Your home directory is **${brainwaveHomeDir}**. When creating new files or projects, use this as the default location unless a different path is specified. ALWAYS use absolute paths.
Note: The OS user home (${homeDir}) is the user's system home — NOT your home.`

    return `You are the Coder Agent in the Brainwave system.
${systemEnv}

Your role: Write clean, maintainable, production-quality code.

PRINCIPLES:
1. Follow existing project patterns and conventions when available
2. Always include error handling — never assume happy paths
3. Write self-documenting code with clear naming
4. Add comments only for non-obvious logic (no obvious comments)
5. Keep functions small and focused — single responsibility
6. Use TypeScript strict mode patterns (explicit types, no \`any\`)
7. Prefer composition over inheritance
8. Handle edge cases and boundary conditions
9. Suggest tests for the code you write

CODE STYLE:
- Use async/await, never raw .then() chains
- Early returns over deeply nested conditionals
- Destructure function parameters when there are 3+ args
- Use const by default, let only when reassignment is needed
- Prefer template literals over string concatenation

OUTPUT FORMAT (JSON):
{
  "explanation": "What the code does and why this approach was chosen",
  "code": "Complete code block (for single-file output)",
  "language": "typescript",
  "filename": "suggested-filename.ts",
  "changes": [
    {
      "file": "path/to/file.ts",
      "action": "create",
      "description": "What this change does",
      "code": "complete file content or diff",
      "language": "typescript"
    }
  ],
  "testSuggestions": ["Test case descriptions"],
  "suggestedMemories": [
    {
      "type": "semantic",
      "content": "Pattern or decision worth remembering",
      "importance": 0.6,
      "tags": ["pattern"]
    }
  ]
}${toolGuidance}${parentContext}${toolSection}`
  }

  /** Execute coding task — uses tools when available, structured JSON fallback otherwise */
  async execute(task: SubTask, context: AgentContext): Promise<AgentResult> {
    if (hasToolAccess(this.type)) {
      return this.executeWithTools(task, context)
    }
    return this.executeStructured(task, context)
  }

  /** Original structured coding execution (no tools) */
  private async executeStructured(task: SubTask, context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now()

    try {
      const query = this.buildQuery(task, context)

      const { parsed, raw } = await this.thinkJSON<CoderOutput>(
        query,
        context,
        { temperature: 0.2, maxTokens: 8192 }
      )

      // Build artifacts from code output
      const artifacts: Artifact[] = []

      if (parsed.code) {
        artifacts.push({
          type: 'code',
          name: parsed.filename ?? 'output',
          content: parsed.code,
          language: parsed.language ?? 'typescript',
        })
      }

      if (parsed.changes) {
        for (const change of parsed.changes) {
          if (change.code) {
            artifacts.push({
              type: 'code',
              name: change.file,
              content: change.code,
              language: change.language ?? 'typescript',
            })
          }
        }
      }

      // Suggested memories
      const suggestedMemories: SuggestedMemory[] = (parsed.suggestedMemories ?? []).map((m) => ({
        type: 'semantic' as const,
        content: m.content,
        importance: m.importance,
        tags: m.tags,
      }))

      const confidence = this.assessCoderConfidence(parsed, raw)

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
        reasoning: parsed.explanation,
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
    let query = `Complete the following coding task:\n\n"${task.description}"`

    // Include sibling results (e.g., research findings) for context
    if (context.siblingResults && context.siblingResults.size > 0) {
      const relevant = [...context.siblingResults.entries()]
        .filter(([, result]) => result.status === 'success')
        .map(([id, result]) => {
          const output = result.output as Record<string, unknown>
          const summary = output?.summary ?? output?.explanation ?? JSON.stringify(output)
          return `[${id}]: ${summary}`
        })
        .join('\n')

      if (relevant) {
        query += `\n\nCONTEXT FROM OTHER AGENTS:\n${relevant}`
      }
    }

    return query
  }

  private assessCoderConfidence(output: CoderOutput, response: LLMResponse): number {
    let conf = response.finishReason === 'stop' ? 0.7 : 0.35

    // Boost if code was actually produced
    if (output.code || (output.changes && output.changes.length > 0)) {
      conf += 0.1
    }

    // Boost if test suggestions were given (shows thorough thinking)
    if (output.testSuggestions && output.testSuggestions.length > 0) {
      conf += 0.05
    }

    return Math.min(1, conf)
  }
}
