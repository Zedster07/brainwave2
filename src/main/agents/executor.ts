/**
 * Executor Agent — Calls tools to perform real-world actions
 *
 * When the planner assigns a task to the executor, this agent:
 * 1. Reviews available tools (built-in local tools + MCP tools)
 * 2. Uses the LLM to decide which tool to call and with what arguments
 * 3. Calls the tool via the local provider or MCP registry
 * 4. Returns the results as an AgentResult
 *
 * Built-in local tools: file_read, file_write, file_delete, shell_execute
 * All local tool calls are gated through the Hard Rules Engine.
 *
 * If no tools are available at all, falls back to LLM-only reasoning.
 */
import os from 'os'
import type { AgentType } from './event-bus'
import { BaseAgent, type SubTask, type AgentContext, type AgentResult, type Artifact } from './base-agent'
import { LLMFactory, type LLMResponse } from '../llm'
import { getMcpRegistry } from '../mcp'
import { getLocalToolProvider } from '../tools'

export class ExecutorAgent extends BaseAgent {
  readonly type: AgentType = 'executor'
  readonly capabilities = ['execution', 'automation', 'tooling', 'mcp-tools', 'file-ops', 'shell', 'network', 'file-create', 'file-move', 'directory-list', 'http-request']
  readonly description = 'Full local computer access — reads/writes/creates/deletes/moves files, lists directories, executes shell commands, makes HTTP requests. All safety-gated.'

  protected getSystemPrompt(context: AgentContext): string {
    const localCatalog = getLocalToolProvider().getToolCatalog()
    const mcpCatalog = getMcpRegistry().getToolCatalog()
    const fullCatalog = [localCatalog, mcpCatalog].filter(Boolean).join('\n\n')

    const toolSection = fullCatalog
      ? `\n\n${fullCatalog}\n\nTo call a tool, respond with a JSON object:\n` +
        `{ "tool": "<tool_key>", "args": { ... } }\n\n` +
        `- tool_key format is "serverId::toolName" (e.g. "local::file_read", "local::directory_list", "local::http_request", or "abc123::search")\n` +
        `- args must match the tool's input schema\n` +
        `- You can call ONE tool per response — NEVER output multiple tool calls\n` +
        `- Your entire response MUST be a single JSON object — NO text before or after it\n` +
        `- After seeing the tool result, decide: call another tool OR provide your final answer\n` +
        `- For file paths, always use absolute paths\n` +
        `- On Windows, use backslashes (e.g. "C:\\Users\\...") or forward slashes`
      : '\n\nNo tools are currently available. Answer using your knowledge only.'

    // Gather real system context so the LLM never has to guess paths
    const homeDir = os.homedir()
    const username = os.userInfo().username
    const platform = os.platform()
    const hostname = os.hostname()
    const desktopPath = platform === 'win32'
      ? `${homeDir}\\Desktop`
      : `${homeDir}/Desktop`
    const documentsPath = platform === 'win32'
      ? `${homeDir}\\Documents`
      : `${homeDir}/Documents`
    const downloadsPath = platform === 'win32'
      ? `${homeDir}\\Downloads`
      : `${homeDir}/Downloads`

    return `You are the Executor agent in the Brainwave system.

## System Environment
- Platform: ${platform} (${os.arch()})
- Hostname: ${hostname}
- Username: ${username}
- Home directory: ${homeDir}
- Desktop: ${desktopPath}
- Documents: ${documentsPath}
- Downloads: ${downloadsPath}
- Shell working directory (CWD): ${process.cwd()}

ALWAYS use these REAL paths — NEVER guess or use placeholders like "YourUsername".

## CRITICAL: Shell Commands & Working Directory
- shell_execute runs commands from CWD: ${process.cwd()}
- This is the Brainwave app directory — NOT the user's home or Desktop!
- ALWAYS use ABSOLUTE PATHS in shell commands (e.g. "node C:\\Users\\${username}\\Desktop\\hello.js")
- Or specify the "cwd" argument: { "tool": "local::shell_execute", "args": { "command": "node hello.js", "cwd": "C:\\Users\\${username}\\Desktop" } }
- NEVER run commands with relative paths assuming the user's Desktop or home directory

## Capabilities
You have ALMOST FULL ACCESS to the user's computer. You can:
- READ files (any text, code, config, log, etc.)
- WRITE / CREATE files (create new files or overwrite existing ones)
- DELETE files
- MOVE / RENAME files and directories
- LIST directory contents (see what's in any folder)
- EXECUTE shell commands (git, npm, python, node, pip, curl, powershell, cmd, etc.)
- MAKE HTTP requests (GET, POST, PUT, DELETE to any API or URL)

All actions are safety-gated — the Hard Rules Engine blocks dangerous operations (e.g. system directories,
destructive commands like format/shutdown, protected file extensions like .exe/.bat).

## Rules
- You MUST use tools to complete tasks — do NOT just describe what you would do, ACTUALLY DO IT.
- When the user asks you to read a file, LIST a directory, run a command, etc. — CALL THE TOOL.
- Be precise with tool arguments. Use the real paths from the System Environment above.
- NEVER ask the user follow-up questions. NEVER ask for permission. NEVER say "would you like me to...".
  You are autonomous — figure it out yourself and DO IT.
- If a tool call FAILS, try a DIFFERENT approach immediately:
  • Wrong path? Use shell_execute or directory_list to discover the correct path.
  • Permission denied? Try an alternative location or command.
  • Command not found? Try an equivalent command.
- If a tool call SUCCEEDS but the task is NOT yet complete, call ANOTHER tool immediately.
  Do NOT stop to summarize partial results. Keep working until the task is FULLY complete.
- Use EFFICIENT strategies:
  • To find a file/folder: use shell_execute with "dir /s /b \\*NAME\\*" on Windows or "find / -name NAME" on Linux.
    Do NOT manually list directories one by one — use recursive search commands.
  • To search file contents: use shell_execute with "findstr /s /i PATTERN *.*" or "grep -r PATTERN".
  • To discover system info: use shell_execute with "systeminfo", "wmic", "hostname", etc.
- When the task IS complete and you have the final answer, respond with ONLY a JSON object:
  { "done": true, "summary": "your final answer here" }
- Always provide a clear, concrete summary of what was accomplished — not what you "would" do.${toolSection}`
  }

  async execute(task: SubTask, context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now()
    const modelConfig = LLMFactory.getAgentConfig(this.type)
    const registry = getMcpRegistry()
    const localProvider = getLocalToolProvider()
    const mcpTools = registry.getAllTools()
    const localTools = localProvider.getTools()
    const allTools = [...localTools, ...mcpTools]

    // If no tools available at all, use standard LLM-only execution
    if (allTools.length === 0) {
      return super.execute(task, context)
    }

    this.bus.emitEvent('agent:thinking', {
      agentType: this.type,
      taskId: context.taskId,
      model: modelConfig?.model ?? 'unknown',
    })

    let totalTokensIn = 0
    let totalTokensOut = 0
    let model = modelConfig?.model ?? 'unknown'
    const artifacts: Artifact[] = []
    const toolResults: Array<{ tool: string; success: boolean; content: string }> = []

    const MAX_STEPS = 8
    let corrections = 0
    const MAX_CORRECTIONS = 2
    const EXECUTOR_TIMEOUT_MS = 3 * 60 * 1000 // 3 minutes overall timeout

    console.log(`[Executor] Starting | taskId=${context.taskId} | model=${model} | tools=${allTools.length} (${localTools.length} local, ${mcpTools.length} mcp)`)
    console.log(`[Executor] Task: "${task.description.slice(0, 200)}"`)

    try {
      // Agentic multi-step loop — the LLM keeps calling tools until the task is done.
      // After each tool result (success or failure), the full history is fed back so
      // the LLM can decide: call another tool, or signal completion with { "done": true }.

      // Build context from prior subtask results (sibling tasks in the plan)
      let priorContext = ''
      if (context.siblingResults && context.siblingResults.size > 0) {
        const priorLines: string[] = []
        for (const [stepId, result] of context.siblingResults) {
          if (result.status === 'success' || result.status === 'partial') {
            const output = typeof result.output === 'string'
              ? result.output.slice(0, 500)
              : JSON.stringify(result.output).slice(0, 500)
            priorLines.push(`- ${stepId}: ${output}`)
          }
        }
        if (priorLines.length > 0) {
          priorContext = `\n\nPRIOR STEPS ALREADY COMPLETED (use this context — do NOT redo these):\n${priorLines.join('\n')}\n`
        }
      }

      // Include the parent task for broader context
      const parentContext = context.parentTask
        ? `\nORIGINAL USER REQUEST: "${context.parentTask.slice(0, 300)}"\n`
        : ''

      let currentPrompt =
        `TASK: ${task.description}\n${parentContext}${priorContext}\n` +
        `Respond with a JSON tool call to begin working on this task. ` +
        `Example: { "tool": "local::shell_execute", "args": { "command": "dir /s /b \\\\*steam* 2>nul" } }\n` +
        `Do NOT respond with text. You MUST output a JSON object.`

      for (let step = 1; step <= MAX_STEPS; step++) {
        // Check overall timeout
        if (Date.now() - startTime > EXECUTOR_TIMEOUT_MS) {
          const anySuccess = toolResults.some((t) => t.success)
          const timeoutResult = this.buildResult(
            anySuccess ? 'partial' : 'failed',
            `Executor timed out after ${Math.round((Date.now() - startTime) / 1000)}s. ` +
            (toolResults.length > 0
              ? `Completed ${toolResults.length} tool call(s) before timeout. Last results:\n` +
                toolResults.slice(-2).map((t) => `${t.tool}: ${t.content.slice(0, 300)}`).join('\n')
              : 'No tool calls completed.'),
            anySuccess ? 0.5 : 0.2,
            totalTokensIn,
            totalTokensOut,
            model,
            startTime,
            artifacts
          )

          this.bus.emitEvent('agent:error', {
            agentType: this.type,
            taskId: context.taskId,
            error: `Executor timed out after ${Math.round((Date.now() - startTime) / 1000)}s`,
          })

          return timeoutResult
        }

        // Emit step progress so the UI updates
        this.bus.emitEvent('agent:acting', {
          agentType: this.type,
          taskId: context.taskId,
          action: `Step ${step}/${MAX_STEPS}: ${step === 1 ? 'Analyzing task...' : 'Deciding next action...'}`,
        })

        // Ask the LLM what to do next
        const response = await this.think(currentPrompt, context, {
          temperature: modelConfig?.temperature ?? 0.1,
          maxTokens: modelConfig?.maxTokens,
          responseFormat: 'json',
        })

        totalTokensIn += response.tokensIn
        totalTokensOut += response.tokensOut
        model = response.model

        // Check if the LLM signaled completion with { "done": true, "summary": "..." }
        const doneSignal = this.parseDoneSignal(response.content)
        if (doneSignal) {
          console.log(`[Executor] Done signal received at step ${step}: "${doneSignal.slice(0, 200)}..."`)
          const anySuccess = toolResults.some((t) => t.success)
          const finalResult = this.buildResult(
            anySuccess ? 'success' : (toolResults.length > 0 ? 'partial' : 'success'),
            doneSignal,
            anySuccess ? 0.9 : 0.7,
            totalTokensIn,
            totalTokensOut,
            model,
            startTime,
            artifacts
          )

          this.bus.emitEvent('agent:completed', {
            agentType: this.type,
            taskId: context.taskId,
            confidence: finalResult.confidence,
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            toolsCalled: toolResults.map((t) => t.tool),
          })

          return finalResult
        }

        // Try to parse a tool call from the response
        const toolCall = this.parseToolCall(response.content)

        if (!toolCall) {
          console.warn(`[Executor] Step ${step}: No tool call or done signal parsed. Raw: ${response.content.slice(0, 200)}`)
          // LLM output JSON but not a tool call or done signal.
          // Re-prompt with correction if we haven't exceeded correction limit.
          if (corrections < MAX_CORRECTIONS) {
            corrections++
            this.bus.emitEvent('agent:acting', {
              agentType: this.type,
              taskId: context.taskId,
              action: `Sending correction ${corrections}/${MAX_CORRECTIONS} — invalid response format`,
            })
            currentPrompt =
              `TASK: ${task.description}\n\n` +
              (toolResults.length > 0
                ? `== TOOL HISTORY ==\n${toolResults.map((t, i) =>
                    `Step ${i + 1}: ${t.tool} → ${t.success ? 'SUCCESS' : 'FAILED'}:\n${t.content.slice(0, 800)}`
                  ).join('\n\n')}\n\n`
                : '') +
              `== ERROR: INVALID RESPONSE FORMAT ==\n` +
              `Your last response was not a valid tool call or completion signal.\n` +
              `You responded with: ${response.content.slice(0, 200)}\n\n` +
              `You MUST respond with EXACTLY one of these JSON formats:\n\n` +
              `To call a tool:\n{ "tool": "local::shell_execute", "args": { "command": "your command here" } }\n\n` +
              `To call directory_list:\n{ "tool": "local::directory_list", "args": { "path": "C:\\\\" } }\n\n` +
              `To signal task completion:\n{ "done": true, "summary": "your final answer here" }\n\n` +
              `Do NOT include any text outside the JSON object. Respond with ONLY the JSON.`
            continue
          }

          // Too many corrections — treat as final answer
          const anySuccess = toolResults.some((t) => t.success)
          const finalResult = this.buildResult(
            anySuccess ? 'success' : (toolResults.length > 0 ? 'partial' : 'success'),
            response.content,
            anySuccess ? 0.85 : 0.7,
            totalTokensIn,
            totalTokensOut,
            model,
            startTime,
            artifacts
          )

          this.bus.emitEvent('agent:completed', {
            agentType: this.type,
            taskId: context.taskId,
            confidence: finalResult.confidence,
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            toolsCalled: toolResults.map((t) => t.tool),
          })

          return finalResult
        }

        // Execute the tool
        console.log(`[Executor] Step ${step}: Calling ${toolCall.tool} with args: ${JSON.stringify(toolCall.args).slice(0, 200)}`)

        this.bus.emitEvent('agent:acting', {
          agentType: this.type,
          taskId: context.taskId,
          action: `Calling tool: ${toolCall.tool}${step > 1 ? ` (step ${step})` : ''}`,
        })

        const result = toolCall.tool.startsWith('local::')
          ? await localProvider.callTool(toolCall.tool.split('::')[1], toolCall.args)
          : await registry.callTool(toolCall.tool, toolCall.args)

        console.log(`[Executor] Step ${step}: ${toolCall.tool} → ${result.success ? 'SUCCESS' : 'FAILED'} | ${result.content.slice(0, 200)}`)

        toolResults.push({
          tool: toolCall.tool,
          success: result.success,
          content: result.content,
        })

        artifacts.push({
          type: 'json',
          name: `tool-result-${toolCall.tool.split('::').pop()}-step${step}`,
          content: JSON.stringify(result, null, 2),
        })

        // Build context for the next iteration — include the full history
        const historyLines = toolResults.map((t, i) =>
          `Step ${i + 1}: ${t.tool} → ${t.success ? 'SUCCESS' : 'FAILED'}:\n${t.content.length > 1500 ? t.content.slice(0, 1500) + '\n...(truncated)' : t.content}`
        ).join('\n\n')

        currentPrompt =
          `TASK: ${task.description}\n\n` +
          `== TOOL HISTORY (${toolResults.length} step${toolResults.length > 1 ? 's' : ''} so far) ==\n${historyLines}\n\n` +
          `== INSTRUCTIONS ==\n` +
          `You have ${MAX_STEPS - step} tool calls remaining.\n` +
          (result.success
            ? `The last tool call succeeded. Analyze the result:\n` +
              `- If the task is FULLY complete and you have the final answer, respond with: { "done": true, "summary": "your answer" }\n` +
              `- If the task is NOT complete, call another tool NOW. Do NOT ask the user anything. Do NOT stop to explain.\n` +
              `  Use efficient strategies: recursive search commands (dir /s /b, Get-ChildItem -Recurse), not manual directory listing.`
            : `The last tool call FAILED. Do NOT give up. Try a DIFFERENT approach immediately:\n` +
              `- Different tool, different path, different command.\n` +
              `- Use shell_execute for flexible commands when directory_list fails.\n` +
              `Respond with a new tool call JSON.`)
      }

      // Exhausted all steps — ask for a final summary
      const summaryPrompt =
        `Original task: ${task.description}\n\n` +
        `You've used ${MAX_STEPS} tool calls. Here's what happened:\n` +
        toolResults.map((t, i) =>
          `Step ${i + 1}: ${t.tool} → ${t.success ? 'SUCCESS' : 'FAILED'}: ${t.content.slice(0, 300)}`
        ).join('\n') +
        `\n\nProvide a final summary of what was accomplished and what remains incomplete.`

      const summaryResponse = await this.think(summaryPrompt, context, {
        temperature: 0.3,
        maxTokens: modelConfig?.maxTokens,
      })

      totalTokensIn += summaryResponse.tokensIn
      totalTokensOut += summaryResponse.tokensOut

      const anySuccess = toolResults.some((t) => t.success)
      const finalResult = this.buildResult(
        anySuccess ? 'partial' : 'failed',
        summaryResponse.content,
        anySuccess ? 0.6 : 0.3,
        totalTokensIn,
        totalTokensOut,
        model,
        startTime,
        artifacts
      )

      this.bus.emitEvent('agent:completed', {
        agentType: this.type,
        taskId: context.taskId,
        confidence: finalResult.confidence,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        toolsCalled: toolResults.map((t) => t.tool),
      })

      return finalResult
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)

      this.bus.emitEvent('agent:error', {
        agentType: this.type,
        taskId: context.taskId,
        error,
      })

      return this.buildResult(
        'failed',
        null,
        0,
        totalTokensIn,
        totalTokensOut,
        model,
        startTime,
        artifacts,
        error
      )
    }
  }

  /** Parse a tool call from the LLM's response */
  private parseToolCall(
    content: string
  ): { tool: string; args: Record<string, unknown> } | null {
    // Skip if this is a genuine done signal (parseDoneSignal already rejects
    // done signals whose summary is a tool call, so if it returns non-null
    // here it's a real completion)
    if (this.parseDoneSignal(content)) return null

    const extractTool = (parsed: Record<string, unknown>): { tool: string; args: Record<string, unknown> } | null => {
      // Direct tool call: { "tool": "local::web_search", "args": {...} }
      if (parsed.tool && typeof parsed.tool === 'string') {
        return { tool: parsed.tool, args: (parsed.args as Record<string, unknown>) ?? {} }
      }
      // Unwrap confused done-wrapped tool call: { "done": true, "summary": "{\"tool\": ...}" }
      if (parsed.done === true && typeof parsed.summary === 'string') {
        try {
          const nested = JSON.parse(parsed.summary)
          if (nested.tool && typeof nested.tool === 'string') {
            console.log('[Executor] Extracted tool call from done-wrapped summary')
            return { tool: nested.tool, args: nested.args ?? {} }
          }
        } catch { /* not a nested tool call */ }
      }
      return null
    }

    // 1. Try full content as JSON
    try {
      const result = extractTool(JSON.parse(content))
      if (result) return result
    } catch { /* not pure JSON */ }

    // 2. Try markdown code block
    const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (jsonMatch) {
      try {
        const result = extractTool(JSON.parse(jsonMatch[1]))
        if (result) return result
      } catch { /* Not valid JSON in code block */ }
    }

    // 3. Handle mixed prose + tool calls, and multiple tool calls separated by [TOOL_CALL]
    //    Split on [TOOL_CALL] markers, then extract the first valid JSON tool call from any chunk.
    const chunks = content.split(/\[TOOL_CALL\]/i)
    for (const chunk of chunks) {
      const extracted = this.extractFirstJsonObject(chunk)
      if (extracted) {
        try {
          const result = extractTool(JSON.parse(extracted))
          if (result) {
            if (chunks.length > 1) {
              console.log(`[Executor] Extracted first tool call from ${chunks.length} [TOOL_CALL] chunks`)
            }
            return result
          }
        } catch { /* keep trying next chunk */ }
      }
    }

    return null
  }

  /**
   * Extract the first balanced JSON object from a string that may contain
   * surrounding prose text. Uses bracket counting to find the matching '}'.
   */
  private extractFirstJsonObject(text: string): string | null {
    const start = text.indexOf('{')
    if (start === -1) return null

    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (escape) { escape = false; continue }
      if (ch === '\\' && inString) { escape = true; continue }
      if (ch === '"' && !escape) { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          return text.slice(start, i + 1)
        }
      }
    }
    return null // unbalanced
  }

  /** Parse a done signal { "done": true, "summary": "..." } from the LLM's response */
  private parseDoneSignal(content: string): string | null {
    const extractDone = (parsed: Record<string, unknown>): string | null => {
      if (parsed.done === true && typeof parsed.summary === 'string') {
        // Guard: if the summary itself looks like a tool call, the LLM is confused —
        // it wrapped a tool call in done instead of actually calling it. Reject it
        // so parseToolCall can extract and execute the embedded tool call.
        if (this.looksLikeToolCall(parsed.summary)) {
          console.log('[Executor] Rejecting done signal — summary is an embedded tool call')
          return null
        }
        return parsed.summary
      }
      return null
    }

    // Guard: if the response contains [TOOL_CALL] markers or multiple { "tool": ... } objects,
    // it's NOT a done signal — it's multiple tool calls. Reject early.
    if (/\[TOOL_CALL\]/i.test(content)) return null

    try {
      return extractDone(JSON.parse(content))
    } catch {
      // Try to extract from markdown code block
      const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      if (jsonMatch) {
        try {
          const result = extractDone(JSON.parse(jsonMatch[1]))
          if (result) return result
        } catch { /* ignore */ }
      }

      // Try to find a { "done": true } object using balanced extraction
      const extracted = this.extractFirstJsonObject(content)
      if (extracted) {
        try {
          const result = extractDone(JSON.parse(extracted))
          if (result) return result
        } catch { /* ignore */ }
      }
    }
    return null
  }

  /** Quick check: does this string look like a tool call JSON? */
  private looksLikeToolCall(s: string): boolean {
    try {
      const p = JSON.parse(s.trim())
      return !!(p.tool && typeof p.tool === 'string')
    } catch {
      return false
    }
  }

  /** Helper to build an AgentResult */
  private buildResult(
    status: 'success' | 'partial' | 'failed',
    output: unknown,
    confidence: number,
    tokensIn: number,
    tokensOut: number,
    model: string,
    startTime: number,
    artifacts: Artifact[],
    error?: string
  ): AgentResult {
    return {
      status,
      output,
      confidence,
      tokensIn,
      tokensOut,
      model,
      promptVersion: this.lastPromptVersion,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      error,
      duration: Date.now() - startTime,
    }
  }
}
