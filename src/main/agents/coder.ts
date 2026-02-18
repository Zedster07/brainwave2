/**
 * Coder Agent — Code generation, modification, and explanation
 *
 * Writes clean, well-structured code following project conventions.
 * When tools are available, can read/write actual files and search docs.
 * Falls back to structured JSON output when tools aren't available.
 */
import { BaseAgent, type AgentContext, type AgentResult, type SubTask, type Artifact, type SuggestedMemory } from './base-agent'
import { buildSystemEnvironmentBlock } from './environment'
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
    const toolSection = toolsAvailable ? this.buildToolSection(context.mode) : ''

    // System environment for path awareness
    const systemEnv = buildSystemEnvironmentBlock(this.getBrainwaveHomeDir())

    const toolGuidance = toolsAvailable
      ? `\n## Tool Use Guidelines
- Use file_read to examine existing code BEFORE modifying it
- Use directory_list and search_files to understand project structure
- Use file_write / file_create to write code to actual files
- Use web_search / webpage_fetch to look up documentation
- ALWAYS read existing code before proposing changes
- When writing code, always provide COMPLETE implementations — no placeholders

## File Editing Strategy
1. ALWAYS read a file before editing it — never assume its contents
2. Use replace_in_file with EXACT search content copied from the file
3. If replace_in_file fails, re-read the file (it may have changed) and retry
4. For large changes, prefer multiple small replace_in_file calls over one large rewrite
5. After 3 failed edit attempts on the same file, use write_to_file to replace entirely
6. After making changes, read the modified file to verify correctness

## Verification & TDD Protocol (MANDATORY)
1. **Test-Driven Development (TDD)**:
   - When creating new logic, ALWAYS create a test file FIRST (e.g. \`foo.test.ts\`).
   - Run the test with \`run_test\` (it should fail).
   - Write the implementation to satisfy the test.
   - Run the test again (it should pass).
2. **Instant Diagnostics**:
   - Before running a full build, check for syntax/type errors using \`get_file_diagnostics\`.
   - Fix any errors reported by the diagnostics tool immediately.
   - This validates your code faster than running the full build process.
3. **Full Build Verification**:
   - Once tests pass and diagnostics are clean, run the full build (\`npm run build\` or equivalent).
   - Fix any remaining ecosystem/integration errors.
   - NEVER consider a task done until tests pass AND the build is clean.`
      : ''

    return `You are Brainwave, a highly skilled software engineer with expertise across many languages and frameworks.

${systemEnv}

## Role
Write clean, maintainable, production-quality code.

## Thinking
Before each action, briefly reason about:
- What you know so far about the codebase
- What you need to find out next
- Why you're choosing this particular approach
Write your reasoning as plain text before making tool calls.

## Code Quality Rules
- Follow existing project patterns and conventions
- Add error handling to all async operations — never assume happy paths
- Write self-documenting code with clear naming
- Add comments only for non-obvious logic
- Keep functions small and focused — single responsibility
- Use TypeScript strict mode patterns (explicit types, no \`any\`)
- Prefer composition over inheritance
- Handle edge cases and boundary conditions
- Use async/await, never raw .then() chains
- Early returns over deeply nested conditionals
- Use const by default, let only when reassignment is needed
${toolGuidance}${parentContext}${toolSection}`
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
