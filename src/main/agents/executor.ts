/**
 * Executor Agent — Calls MCP tools to perform real-world actions
 *
 * When the planner assigns a task to the executor, this agent:
 * 1. Reviews the available MCP tools
 * 2. Uses the LLM to decide which tool(s) to call and with what arguments
 * 3. Calls the tool(s) via the MCP registry
 * 4. Returns the results as an AgentResult
 *
 * If no MCP tools are available, falls back to LLM-only reasoning.
 */
import type { AgentType } from './event-bus'
import { BaseAgent, type SubTask, type AgentContext, type AgentResult, type Artifact } from './base-agent'
import { LLMFactory, type LLMResponse } from '../llm'
import { getMcpRegistry } from '../mcp'

export class ExecutorAgent extends BaseAgent {
  readonly type: AgentType = 'executor'
  readonly capabilities = ['execution', 'automation', 'tooling', 'mcp-tools']
  readonly description = 'Task execution via MCP tools — file ops, web search, API calls, and more'

  protected getSystemPrompt(context: AgentContext): string {
    const registry = getMcpRegistry()
    const catalog = registry.getToolCatalog()

    const toolSection = catalog
      ? `\n\n${catalog}\n\nTo call a tool, respond with a JSON object:\n` +
        `{ "tool": "<tool_key>", "args": { ... } }\n\n` +
        `- tool_key format is "serverId::toolName"\n` +
        `- args must match the tool's input schema\n` +
        `- You can call ONE tool per response\n` +
        `- After seeing the tool result, provide your final answer`
      : '\n\nNo MCP tools are currently connected. Answer using your knowledge only.'

    return `You are the Executor agent in the Brainwave system.

Your role is to complete tasks by calling MCP tools when available,
or providing the best possible answer using your knowledge.

Be precise with tool arguments. Report errors clearly.
Always provide a clear summary of what was accomplished.${toolSection}`
  }

  async execute(task: SubTask, context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now()
    const modelConfig = LLMFactory.getAgentConfig(this.type)
    const registry = getMcpRegistry()
    const tools = registry.getAllTools()

    // If no tools available, use standard LLM-only execution
    if (tools.length === 0) {
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

    try {
      // Step 1: Ask the LLM what tool to call
      const response = await this.think(task.description, context, {
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
          'success',
          response.content,
          0.7,
          totalTokensIn,
          totalTokensOut,
          model,
          startTime,
          artifacts
        )
      }

      // Step 3: Execute the tool
      this.bus.emitEvent('agent:acting', {
        agentType: this.type,
        taskId: context.taskId,
        action: `Calling tool: ${toolCall.tool}`,
      })

      const result = await registry.callTool(toolCall.tool, toolCall.args)
      toolResults.push({
        tool: toolCall.tool,
        success: result.success,
        content: result.content,
      })

      // Store raw tool output as artifact
      artifacts.push({
        type: 'json',
        name: `tool-result-${toolCall.tool.split('::').pop()}`,
        content: JSON.stringify(result, null, 2),
      })

      // Step 4: Feed the tool result back to the LLM for a final summary
      const summaryPrompt =
        `Original task: ${task.description}\n\n` +
        `Tool called: ${toolCall.tool}\n` +
        `Tool result (success=${result.success}):\n${result.content}\n\n` +
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
