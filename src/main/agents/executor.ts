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
        `- You can call ONE tool per response\n` +
        `- After seeing the tool result, provide your final answer\n` +
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

ALWAYS use these REAL paths — NEVER guess or use placeholders like "YourUsername".

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
- If a tool call FAILS, analyze the error and try a DIFFERENT approach. For example:
  • Wrong path? Use shell_execute with "dir" / "ls" or directory_list to discover the correct path, then retry.
  • Permission denied? Try an alternative location or command.
  • Command not found? Try an equivalent command.
  NEVER give up after one failure — always attempt to self-correct.
- Always provide a clear summary of what was accomplished.${toolSection}`
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

    const MAX_TOOL_ATTEMPTS = 3

    try {
      // Multi-turn tool loop — allows the LLM to self-correct on failures
      let currentPrompt = task.description
      let lastResult: { success: boolean; content: string } | null = null

      for (let attempt = 1; attempt <= MAX_TOOL_ATTEMPTS; attempt++) {
        // Step 1: Ask the LLM what tool to call
        const response = await this.think(currentPrompt, context, {
          temperature: modelConfig?.temperature ?? 0.1,
          maxTokens: modelConfig?.maxTokens,
          responseFormat: 'json',
        })

        totalTokensIn += response.tokensIn
        totalTokensOut += response.tokensOut
        model = response.model

        // Step 2: Try to parse a tool call from the response
        const toolCall = this.parseToolCall(response.content)

        if (!toolCall) {
          // LLM didn't call a tool — return its text response directly
          return this.buildResult(
            lastResult?.success === false ? 'partial' : 'success',
            response.content,
            0.7,
            totalTokensIn,
            totalTokensOut,
            model,
            startTime,
            artifacts
          )
        }

        // Step 3: Execute the tool — route to local provider or MCP registry
        this.bus.emitEvent('agent:acting', {
          agentType: this.type,
          taskId: context.taskId,
          action: `Calling tool: ${toolCall.tool}${attempt > 1 ? ` (attempt ${attempt})` : ''}`,
        })

        const result = toolCall.tool.startsWith('local::')
          ? await localProvider.callTool(toolCall.tool.split('::')[1], toolCall.args)
          : await registry.callTool(toolCall.tool, toolCall.args)
        toolResults.push({
          tool: toolCall.tool,
          success: result.success,
          content: result.content,
        })
        lastResult = result

        // Store raw tool output as artifact
        artifacts.push({
          type: 'json',
          name: `tool-result-${toolCall.tool.split('::').pop()}${attempt > 1 ? `-attempt${attempt}` : ''}`,
          content: JSON.stringify(result, null, 2),
        })

        // Step 4: If the tool FAILED and we have retries left, ask the LLM to self-correct
        if (!result.success && attempt < MAX_TOOL_ATTEMPTS) {
          currentPrompt =
            `Original task: ${task.description}\n\n` +
            `Attempt ${attempt} failed:\n` +
            `Tool called: ${toolCall.tool}\n` +
            `Error: ${result.content}\n\n` +
            `The tool call failed. Analyze the error and try a DIFFERENT approach.\n` +
            `For example: use shell_execute or directory_list to discover the correct path, ` +
            `try an alternative command, or adjust the arguments.\n` +
            `Respond with a new tool call JSON to retry.`
          continue // Go back to Step 1 with the error context
        }

        // Step 5: Tool succeeded (or last attempt) — get a final summary from the LLM
        const historyContext = toolResults.length > 1
          ? `\n\nPrevious attempts:\n${toolResults.slice(0, -1).map((t, i) =>
              `  Attempt ${i + 1}: ${t.tool} → ${t.success ? 'success' : 'failed'}: ${t.content.slice(0, 200)}`
            ).join('\n')}\n`
          : ''

        const summaryPrompt =
          `Original task: ${task.description}\n\n` +
          `Tool called: ${toolCall.tool}\n` +
          `Tool result (success=${result.success}):\n${result.content}` +
          `${historyContext}\n\n` +
          `Provide a clear summary of the result. If the tool failed, explain what went wrong.`

        const summaryResponse = await this.think(summaryPrompt, context, {
          temperature: 0.3,
          maxTokens: modelConfig?.maxTokens,
        })

        totalTokensIn += summaryResponse.tokensIn
        totalTokensOut += summaryResponse.tokensOut

        const finalResult = this.buildResult(
          result.success ? 'success' : 'partial',
          summaryResponse.content,
          result.success ? 0.85 : 0.4,
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

      // Shouldn't reach here, but safety net
      return this.buildResult(
        'failed',
        `Failed after ${MAX_TOOL_ATTEMPTS} attempts`,
        0,
        totalTokensIn,
        totalTokensOut,
        model,
        startTime,
        artifacts
      )
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
    try {
      // Try direct JSON parse
      const parsed = JSON.parse(content)
      if (parsed.tool && typeof parsed.tool === 'string') {
        return {
          tool: parsed.tool,
          args: parsed.args ?? {},
        }
      }
      return null
    } catch {
      // Try to extract JSON from markdown code blocks
      const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1])
          if (parsed.tool && typeof parsed.tool === 'string') {
            return { tool: parsed.tool, args: parsed.args ?? {} }
          }
        } catch {
          // Not valid JSON in code block
        }
      }

      // Try to find a JSON object in the response
      const objMatch = content.match(/\{[\s\S]*"tool"\s*:\s*"[^"]+[\s\S]*\}/)
      if (objMatch) {
        try {
          const parsed = JSON.parse(objMatch[0])
          if (parsed.tool) return { tool: parsed.tool, args: parsed.args ?? {} }
        } catch {
          // Not valid JSON
        }
      }

      return null
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
