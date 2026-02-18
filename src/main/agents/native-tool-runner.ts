/**
 * Native Tool Runner — M2.5-optimized tool calling loop (Anthropic SDK format)
 *
 * Extracted from BaseAgent.executeWithNativeTools().
 * Handles the complete agentic loop for models that support native tool calling:
 * structured content blocks (thinking + text + tool_use), tool_result responses,
 * prompt caching, and interleaved thinking.
 *
 * M2.5 CARDINAL RULES:
 * - temperature MUST be 1.0 when thinking is enabled
 * - Full response content (including thinking) MUST be preserved in history
 * - thinking blocks MUST NOT be modified or summarized
 * - System prompt goes in top-level `system` param, NOT in messages
 */
import { LLMFactory } from '../llm'
import type {
    ContentBlock,
    ToolResultBlock,
} from '../llm/types'
import {
    getModelCapabilities,
    extractTextFromBlocks,
    extractToolUseBlocks,
    createToolResult,
    textToBlocks,
} from '../llm/types'
import {
    toAnthropicTools,
    ToolNameMap,
    buildCompletionToolDefinition,
    buildDelegationToolDefinition,
    buildParallelDelegationToolDefinition,
} from '../llm/tool-definitions'
import { getDelegationTargets, canDelegate, canDelegateAtDepth } from './delegation'
import type { AgentType } from './event-bus'
import { calculateBudget, formatTokenCount, MAX_INPUT_BUDGET, REASONING_RESERVE_TOKENS, PROACTIVE_COMPACTION_THRESHOLD } from '../llm/token-counter'
import { getMcpRegistry } from '../mcp'
import { getLocalToolProvider } from '../tools'
import { getAgentPermissions, filterToolsForAgent, filterToolsForMode, canAgentCallTool } from '../tools/permissions'
import { getModeRegistry } from '../modes'
import { requiresApproval, requestApproval } from '../tools/approval'
import { ConversationManager } from './conversation-manager'
import { FileContextTracker } from './file-context-tracker'
import type { FileRegistryEntry } from './context-compactor'
import { detectWorkspace, getEnvironmentDetails } from './environment'
import { getInstructionManager } from '../instructions'
import { CancellationError } from './cancellation'
import { summarizeForUI, emitToolCallInfo } from './ui-helpers'
import type { SubTask, AgentContext, AgentResult, Artifact, BaseAgentHandle } from './types'

/**
 * Execute a task using NATIVE tool calling (Anthropic SDK format).
 *
 * This is the M2.5-optimized alternative to the XML protocol.
 * Automatically selected when the agent's model supports native tools.
 *
 * KEY DIFFERENCES from XML protocol:
 * 1. Tools are passed via the API's `tools` parameter (not text in system prompt)
 * 2. Model responds with structured content blocks (thinking + text + tool_use)
 * 3. Tool results are sent as proper tool_result blocks (not XML-in-user-message)
 * 4. Full response (including thinking blocks) is preserved in history
 * 5. No XML parsing needed — tool calls come as structured data
 */
export async function executeWithNativeTools(
    agent: BaseAgentHandle,
    task: SubTask,
    context: AgentContext,
): Promise<AgentResult> {
    const startTime = Date.now()
    const modelConfig = LLMFactory.getAgentConfig(agent.type)
    const permConfig = getAgentPermissions(agent.type)
    const registry = getMcpRegistry()
    const localProvider = getLocalToolProvider()
    const model = modelConfig?.model ?? 'minimax/minimax-m2.5'
    const capabilities = getModelCapabilities(model)

    // Get allowed tools for this agent
    const allTools = [...localProvider.getTools(), ...registry.getAllTools()]
    const modeConfig = context.mode ? getModeRegistry().get(context.mode) : undefined
    const allowedTools = modeConfig
        ? filterToolsForMode(modeConfig, allTools)
        : filterToolsForAgent(agent.type, allTools)

    // Convert to native tool definitions
    // These are `let` because discover_tools can expand the set mid-session
    let nativeTools = toAnthropicTools(allowedTools)
    let toolNameMap = new ToolNameMap(allowedTools)

    // Add completion signal tool
    nativeTools.push(buildCompletionToolDefinition())

    // Add delegation tools if this agent has delegation targets
    const delegationTargets = getDelegationTargets(agent.type as AgentType)
    if (delegationTargets.length > 0 && canDelegateAtDepth(context.delegationDepth ?? 0)) {
        nativeTools.push(buildDelegationToolDefinition(delegationTargets))
        nativeTools.push(buildParallelDelegationToolDefinition(delegationTargets))
        console.log(`[${agent.type}] Delegation enabled → targets: [${delegationTargets.join(', ')}]`)
    }

    // Helper: rebuild tool list when discover_tools loads new deferred tools
    const rebuildToolList = (): void => {
        const updatedAll = [...localProvider.getTools(), ...registry.getAllTools()]
        const updatedAllowed = modeConfig
            ? filterToolsForMode(modeConfig, updatedAll)
            : filterToolsForAgent(agent.type, updatedAll)
        nativeTools = toAnthropicTools(updatedAllowed)
        toolNameMap = new ToolNameMap(updatedAllowed)
        nativeTools.push(buildCompletionToolDefinition())
        // Re-add delegation tools
        if (delegationTargets.length > 0 && canDelegateAtDepth(context.delegationDepth ?? 0)) {
            nativeTools.push(buildDelegationToolDefinition(delegationTargets))
            nativeTools.push(buildParallelDelegationToolDefinition(delegationTargets))
        }
        console.log(`[${agent.type}] Tool list rebuilt: ${nativeTools.length} tools (after discover_tools)`)
    }

    // Native tool calling REQUIRES the Anthropic adapter
    const provider = LLMFactory.getProvider('anthropic')

    agent.bus.emitEvent('agent:thinking', {
        agentType: agent.type,
        taskId: context.taskId,
        model,
    })

    let totalTokensIn = 0
    let totalTokensOut = 0
    const artifacts: Artifact[] = []
    const toolResults: Array<{ tool: string; success: boolean; content: string }> = []

    // Safety constants
    const TIMEOUT_MS = permConfig.timeoutMs ?? 5 * 60 * 1000
    const ABSOLUTE_MAX_STEPS = 100
    const MAX_CONSECUTIVE_ERRORS = 5
    let consecutiveErrors = 0

    // File context tracking
    const fileRegistry = new Map<string, FileRegistryEntry>()
    const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase()
    const fileTracker = new FileContextTracker()

    // Workspace detection
    const workDir = context.workDir
        ?? detectWorkspace(task.description, context.parentTask, agent.getBrainwaveHomeDir())

    // .brainwaveignore
    const instructionMgr = getInstructionManager()
    const ignoreMatcher = await instructionMgr.getIgnoreMatcher(workDir)
    const customInstructionBlock = await instructionMgr.buildBlock({
        workDir,
        mode: context.mode,
    })

    // Initialize conversation manager in native mode
    const rawContextLimit = calculateBudget(model, 0).contextLimit
    const cappedBudget = Math.min(rawContextLimit, MAX_INPUT_BUDGET)
    const responseReserve = capabilities.supportsThinking
        ? 8_000 + REASONING_RESERVE_TOKENS
        : 8_000
    const conversation = new ConversationManager(cappedBudget, responseReserve)
    conversation.enableNativeMode()

    console.log(
        `[${agent.type}] executeWithNativeTools | taskId=${context.taskId} | model=${model} | ` +
        `tools=${nativeTools.length} | timeout=${Math.round(TIMEOUT_MS / 1000)}s | native=true | ` +
        `budget=${cappedBudget} (raw=${rawContextLimit}) | responseReserve=${responseReserve}`
    )

    try {
        // ── Build system prompt (strip XML tool catalog — tools go via API param) ──
        const rawSystemPrompt = await agent.getSystemPrompt(context)
        const systemPrompt = rawSystemPrompt.replace(/\n+## Available Tools[\s\S]*$/, '')
        const systemWithInstructions = customInstructionBlock
            ? `${systemPrompt}\n\n${customInstructionBlock}`
            : systemPrompt

        // ── Build initial user message ──
        let priorContext = ''
        if (context.siblingResults && context.siblingResults.size > 0) {
            const priorLines: string[] = []
            for (const [stepId, result] of context.siblingResults) {
                if (result.status === 'success' || result.status === 'partial') {
                    const output = typeof result.output === 'string'
                        ? result.output
                        : JSON.stringify(result.output)
                    priorLines.push(`- ${stepId}: ${output}`)
                }
            }
            if (priorLines.length > 0) {
                priorContext = `\n\nPRIOR STEPS ALREADY COMPLETED:\n${priorLines.join('\n')}\n`
            }
        }

        const parentContext = context.parentTask
            ? `\nORIGINAL USER REQUEST: "${context.parentTask}"\n`
            : ''

        let historyContext = ''
        if (context.conversationHistory && context.conversationHistory.length > 0) {
            const recent = context.conversationHistory.slice(-6)
            const lines = recent.map(msg =>
                `${msg.role === 'user' ? 'User' : 'Brainwave'}: ${msg.content}`
            ).join('\n')
            historyContext = `\n\nRECENT CONVERSATION:\n${lines}\n`
        }

        const envDetails = await getEnvironmentDetails({
            workDir,
            brainwaveHomeDir: agent.getBrainwaveHomeDir(),
            contextLimitTokens: cappedBudget,
            fileTracker,
            includeTree: true,
            treeMaxDepth: 3,
            treeMaxEntries: 200,
        })

        const initialMessage =
            `TASK: ${task.description}\n${parentContext}${historyContext}${priorContext}\n${envDetails}\n` +
            `Begin working on this task. Use the provided tools to take actions.\n` +
            `When done, call the attempt_completion tool with your final result.`

        conversation.addStructuredUserMessage(initialMessage)

        let step = 0

        while (step < ABSOLUTE_MAX_STEPS) {
            step++

            // ── Cancellation check ──
            if (context.cancellationToken?.isCancelled) {
                console.log(`[${agent.type}] Cancelled at step ${step}`)
                const anySuccess = toolResults.some(t => t.success)
                return agent.buildToolResult(
                    anySuccess ? 'partial' : 'failed',
                    anySuccess ? 'Task cancelled. Partial results available.' : 'Task cancelled by user.',
                    anySuccess ? 0.4 : 0.1,
                    totalTokensIn, totalTokensOut, model, startTime, artifacts,
                )
            }

            // ── Timeout check ──
            if (Date.now() - startTime > TIMEOUT_MS) {
                const anySuccess = toolResults.some(t => t.success)
                return agent.buildToolResult(
                    anySuccess ? 'partial' : 'failed',
                    `Timed out after ${Math.round((Date.now() - startTime) / 1000)}s.`,
                    anySuccess ? 0.5 : 0.2,
                    totalTokensIn, totalTokensOut, model, startTime, artifacts,
                )
            }

            agent.bus.emitEvent('agent:acting', {
                agentType: agent.type,
                taskId: context.taskId,
                action: `Step ${step}: ${step === 1 ? 'Analyzing task...' : 'Processing...'}`,
            })

            // ── Token budget check — proactive compaction at 60% ──
            if (step > 1 && conversation.isStructuredNearBudget(PROACTIVE_COMPACTION_THRESHOLD)) {
                const ratio = conversation.getStructuredUsageRatio()
                console.log(
                    `[${agent.type}] Step ${step}: Context at ${Math.round(ratio * 100)}% — proactive compaction`
                )
                conversation.proactiveCompact(0.55)
            }

            // ── Call LLM with native tools ──
            const structuredMessages = conversation.getStructuredMessages()

            // ── Prompt Caching ──
            const systemBlocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [
                { type: 'text', text: systemWithInstructions, cache_control: { type: 'ephemeral' } },
            ]

            const cachedTools = nativeTools.map((t, i) =>
                i === nativeTools.length - 1
                    ? { ...t, cache_control: { type: 'ephemeral' as const } }
                    : t
            )

            const response = await provider.complete({
                model,
                system: systemWithInstructions,
                systemBlocks,
                user: '',
                structuredMessages,
                tools: cachedTools,
                temperature: capabilities.supportsThinking ? 1.0 : (modelConfig?.temperature ?? 0.7),
                maxTokens: modelConfig?.maxTokens ?? 8192,
                signal: context.cancellationToken?.signal,
            })

            totalTokensIn += response.tokensIn
            totalTokensOut += response.tokensOut

            // ── Log cache metrics if available ──
            if (response.cacheMetrics) {
                const { cacheCreationInputTokens, cacheReadInputTokens } = response.cacheMetrics
                if (cacheCreationInputTokens > 0 || cacheReadInputTokens > 0) {
                    console.log(
                        `[${agent.type}] Step ${step} cache: ` +
                        `created=${cacheCreationInputTokens} read=${cacheReadInputTokens} ` +
                        `(${cacheReadInputTokens > 0 ? 'HIT' : 'MISS'})`
                    )
                }
            }

            // ── Preserve FULL response in history (M2.5 cardinal rule) ──
            const contentBlocks = response.contentBlocks ?? textToBlocks(response.content)
            conversation.addStructuredMessage('assistant', contentBlocks)

            const textContent = extractTextFromBlocks(contentBlocks)

            // ── Emit thinking for UI ──
            const thinkingBlocks = contentBlocks.filter(b => b.type === 'thinking')
            if (thinkingBlocks.length > 0) {
                for (const tb of thinkingBlocks) {
                    if (tb.type === 'thinking' && tb.thinking.length > 0) {
                        agent.bus.emitEvent('agent:stream-chunk', {
                            agentType: agent.type,
                            taskId: context.taskId,
                            chunk: `💭 ${tb.thinking}`,
                            isFirst: step === 1 && !textContent,
                        })
                    }
                }
            }

            // ── Emit text for UI streaming ──
            if (textContent) {
                agent.bus.emitEvent('agent:stream-chunk', {
                    agentType: agent.type,
                    taskId: context.taskId,
                    chunk: textContent,
                    isFirst: step === 1,
                })
            }

            // ── Extract tool_use blocks ──
            const toolUseBlocks = extractToolUseBlocks(contentBlocks)

            // ── No tool calls — check if this is a final text response ──
            if (toolUseBlocks.length === 0) {
                if (response.finishReason === 'end_turn' || response.finishReason === 'stop') {
                    console.log(`[${agent.type}] Step ${step}: Model stopped without tools — treating as completion`)
                    const anySuccess = toolResults.some(t => t.success)
                    return agent.buildToolResult(
                        anySuccess ? 'success' : 'partial',
                        textContent || 'Task completed.',
                        anySuccess ? 0.8 : 0.6,
                        totalTokensIn, totalTokensOut, model, startTime, artifacts,
                    )
                }

                conversation.addStructuredNotice(
                    'Your response did not include any tool calls. ' +
                    'Use the available tools to take action, or call attempt_completion to finish.'
                )
                consecutiveErrors++
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    return agent.buildToolResult(
                        'failed',
                        textContent || 'Model failed to use tools.',
                        0.2,
                        totalTokensIn, totalTokensOut, model, startTime, artifacts,
                    )
                }
                continue
            }

            consecutiveErrors = 0

            // ── Process tool calls ──
            const resultBlocks: ContentBlock[] = []

            for (const toolUse of toolUseBlocks) {
                // Check for completion signal
                if (toolUse.name === 'attempt_completion') {
                    const completionResult = (toolUse.input as { result?: string }).result ?? textContent
                    console.log(`[${agent.type}] Completion at step ${step}: "${completionResult?.slice(0, 200)}..."`)
                    const anySuccess = toolResults.some(t => t.success)

                    agent.bus.emitEvent('agent:completed', {
                        agentType: agent.type,
                        taskId: context.taskId,
                        confidence: anySuccess ? 0.9 : 0.7,
                        tokensIn: totalTokensIn,
                        tokensOut: totalTokensOut,
                        toolsCalled: toolResults.map(t => t.tool),
                    })

                    return agent.buildToolResult(
                        anySuccess ? 'success' : 'partial',
                        completionResult ?? 'Task completed.',
                        anySuccess ? 0.9 : 0.7,
                        totalTokensIn, totalTokensOut, model, startTime, artifacts,
                    )
                }

                // ── Delegation: delegate_to_agent ──
                if (toolUse.name === 'delegate_to_agent') {
                    const { agent: targetAgent, task: delegatedTask } = toolUse.input as { agent?: string; task?: string }

                    let delegResult: string
                    let delegSuccess = false

                    if (!targetAgent || !delegatedTask) {
                        delegResult = 'INVALID ARGS: requires agent and task parameters'
                    } else if (!context.delegateFn) {
                        delegResult = 'DELEGATION UNAVAILABLE in this context'
                    } else if (!canDelegateAtDepth(context.delegationDepth ?? 0)) {
                        delegResult = 'DELEGATION DEPTH EXCEEDED — complete the task yourself'
                    } else {
                        const delegPerm = canDelegate(agent.type as AgentType, targetAgent as AgentType)
                        if (!delegPerm.allowed) {
                            delegResult = `DELEGATION DENIED: ${delegPerm.reason}`
                        } else {
                            console.log(`[${agent.type}] Step ${step}: Delegating to ${targetAgent}: "${delegatedTask.slice(0, 150)}"`)
                            agent.bus.emitEvent('agent:acting', {
                                agentType: agent.type,
                                taskId: context.taskId,
                                action: `Delegating to ${targetAgent} (step ${step})`,
                            })

                            try {
                                const subResult = await context.delegateFn(targetAgent as AgentType, delegatedTask)
                                const outputStr = typeof subResult.output === 'string'
                                    ? subResult.output
                                    : JSON.stringify(subResult.output)
                                delegSuccess = subResult.status === 'success' || subResult.status === 'partial'
                                delegResult = outputStr
                                totalTokensIn += subResult.tokensIn
                                totalTokensOut += subResult.tokensOut

                                if (context.blackboard && delegSuccess) {
                                    context.blackboard.board.write(
                                        context.blackboard.planId,
                                        `delegated-${targetAgent}-result`,
                                        outputStr,
                                        agent.type,
                                        context.taskId
                                    )
                                }

                                artifacts.push({
                                    type: 'json',
                                    name: `delegation-${targetAgent}-step${step}`,
                                    content: JSON.stringify({
                                        agent: targetAgent,
                                        status: subResult.status,
                                        confidence: subResult.confidence,
                                        output: outputStr,
                                    }, null, 2),
                                })
                            } catch (err) {
                                delegResult = `DELEGATION FAILED: ${err instanceof Error ? err.message : String(err)}`
                            }
                        }
                    }

                    toolResults.push({ tool: `delegate_to_agent:${targetAgent ?? 'unknown'}`, success: delegSuccess, content: delegResult })
                    resultBlocks.push(createToolResult(toolUse.id, delegResult, !delegSuccess))

                    const delegSummary = delegSuccess
                        ? `Delegated to ${targetAgent} — completed`
                        : `Delegation to ${targetAgent ?? 'agent'} failed`
                    agent.bus.emitEvent('agent:tool-result', {
                        agentType: agent.type,
                        taskId: context.taskId,
                        tool: `delegate_to_agent:${targetAgent ?? 'unknown'}`,
                        success: delegSuccess,
                        summary: delegSummary,
                        step,
                    })
                    emitToolCallInfo(agent.bus, agent.type, {
                        taskId: context.taskId, step,
                        tool: `delegate_to_agent:${targetAgent ?? 'unknown'}`,
                        args: toolUse.input,
                        success: delegSuccess,
                        summary: delegSummary,
                        duration: 0,
                        resultPreview: delegResult.slice(0, 300),
                    })
                    continue
                }

                // ── Delegation: use_subagents (parallel) ──
                if (toolUse.name === 'use_subagents') {
                    const { tasks: tasksRaw } = toolUse.input as { tasks?: unknown }
                    let parsedTasks: Array<{ agent: string; task: string }> = []

                    try {
                        if (typeof tasksRaw === 'string') {
                            parsedTasks = JSON.parse(tasksRaw)
                        } else if (Array.isArray(tasksRaw)) {
                            parsedTasks = tasksRaw as Array<{ agent: string; task: string }>
                        }
                    } catch {
                        const msg = 'INVALID ARGS: tasks must be a valid JSON array of { agent, task } objects'
                        toolResults.push({ tool: 'use_subagents', success: false, content: msg })
                        resultBlocks.push(createToolResult(toolUse.id, msg, true))
                        continue
                    }

                    let parResult: string
                    let parSuccess = false

                    if (!Array.isArray(parsedTasks) || parsedTasks.length === 0) {
                        parResult = 'INVALID ARGS: tasks must be a non-empty array'
                    } else if (!context.parallelDelegateFn) {
                        parResult = 'PARALLEL DELEGATION UNAVAILABLE in this context'
                    } else if (!canDelegateAtDepth(context.delegationDepth ?? 0)) {
                        parResult = 'DELEGATION DEPTH EXCEEDED — complete the tasks yourself'
                    } else {
                        // Validate each task's agent permission
                        const validatedTasks: Array<{ agent: AgentType; task: string }> = []
                        const rejections: string[] = []
                        for (const t of parsedTasks.slice(0, 5)) {
                            const perm = canDelegate(agent.type as AgentType, t.agent as AgentType)
                            if (!perm.allowed) {
                                rejections.push(`"${t.agent}": ${perm.reason}`)
                            } else {
                                validatedTasks.push({ agent: t.agent as AgentType, task: t.task })
                            }
                        }

                        if (validatedTasks.length === 0) {
                            parResult = `ALL DELEGATIONS DENIED:\n${rejections.join('\n')}`
                        } else {
                            console.log(`[${agent.type}] Step ${step}: Parallel delegation → ${validatedTasks.length} sub-agents: ${validatedTasks.map(t => t.agent).join(', ')}`)
                            agent.bus.emitEvent('agent:acting', {
                                agentType: agent.type,
                                taskId: context.taskId,
                                action: `Parallel delegation: ${validatedTasks.length} sub-agents (step ${step})`,
                            })

                            try {
                                const results = await context.parallelDelegateFn(validatedTasks)
                                const resultParts: string[] = []
                                let allSuccess = true
                                for (let i = 0; i < results.length; i++) {
                                    const r = results[i]
                                    const t = validatedTasks[i]
                                    const outputStr = typeof r.output === 'string' ? r.output : JSON.stringify(r.output)
                                    const ok = r.status === 'success' || r.status === 'partial'
                                    if (!ok) allSuccess = false
                                    totalTokensIn += r.tokensIn
                                    totalTokensOut += r.tokensOut

                                    resultParts.push(
                                        `--- Sub-agent: ${t.agent} (${r.status}) ---\n` +
                                        `Task: ${t.task}\n` +
                                        `Result:\n${outputStr}`
                                    )

                                    if (context.blackboard && ok) {
                                        context.blackboard.board.write(
                                            context.blackboard.planId,
                                            `parallel-${t.agent}-${i}-result`,
                                            outputStr,
                                            agent.type,
                                            context.taskId
                                        )
                                    }
                                }

                                parResult = resultParts.join('\n\n')
                                parSuccess = allSuccess

                                if (rejections.length > 0) {
                                    parResult += `\n\nNote: ${rejections.length} sub-task(s) skipped: ${rejections.join('; ')}`
                                }

                                artifacts.push({
                                    type: 'json',
                                    name: `parallel-delegation-step${step}`,
                                    content: JSON.stringify({
                                        tasks: validatedTasks.map((t, i) => ({
                                            agent: t.agent,
                                            task: t.task,
                                            status: results[i].status,
                                            confidence: results[i].confidence,
                                        })),
                                        allSuccess,
                                        rejections,
                                    }, null, 2),
                                })
                            } catch (err) {
                                parResult = `PARALLEL DELEGATION FAILED: ${err instanceof Error ? err.message : String(err)}`
                            }
                        }
                    }

                    toolResults.push({ tool: 'use_subagents', success: parSuccess, content: parResult })
                    resultBlocks.push(createToolResult(toolUse.id, parResult, !parSuccess))

                    const parSummary = parSuccess
                        ? `Parallel delegation (${parsedTasks.length} agents) — completed`
                        : 'Parallel delegation failed'
                    agent.bus.emitEvent('agent:tool-result', {
                        agentType: agent.type,
                        taskId: context.taskId,
                        tool: 'use_subagents',
                        success: parSuccess,
                        summary: parSummary,
                        step,
                    })
                    emitToolCallInfo(agent.bus, agent.type, {
                        taskId: context.taskId, step,
                        tool: 'use_subagents',
                        args: toolUse.input,
                        success: parSuccess,
                        summary: parSummary,
                        duration: 0,
                        resultPreview: parResult.slice(0, 300),
                    })
                    continue
                }

                // Map API name back to internal tool key
                const internalKey = toolNameMap.toInternalKey(toolUse.name)

                // ── Unknown tool guard ──
                // Catch hallucinated tool names (e.g. "read_text_file" instead of "file_read")
                // that pass through ToolNameMap's fallback unsanitize path.
                if (!toolNameMap.isKnownTool(toolUse.name)) {
                    const suggestions = toolNameMap.suggestSimilar(toolUse.name)
                    const hint = suggestions.length > 0
                        ? ` Did you mean: ${suggestions.join(', ')}?`
                        : ' Check the available tools list — only use tool names EXACTLY as provided.'
                    const errMsg = `ERROR: "${toolUse.name}" is NOT a valid tool name.${hint}`
                    console.warn(`[${agent.type}] Step ${step}: HALLUCINATED TOOL: "${toolUse.name}" → suggestions: [${suggestions.join(', ')}]`)
                    toolResults.push({ tool: toolUse.name, success: false, content: errMsg })
                    resultBlocks.push(createToolResult(toolUse.id, errMsg, true))
                    consecutiveErrors++
                    continue
                }

                // Permission check
                const perm = canAgentCallTool(agent.type, internalKey)
                if (!perm.allowed) {
                    console.warn(`[${agent.type}] BLOCKED: ${internalKey} — ${perm.reason}`)
                    toolResults.push({ tool: internalKey, success: false, content: `PERMISSION DENIED: ${perm.reason}` })
                    resultBlocks.push(createToolResult(toolUse.id, `PERMISSION DENIED: ${perm.reason}`, true))
                    continue
                }

                // .brainwaveignore check
                if (ignoreMatcher.hasPatterns) {
                    const targetPath = (toolUse.input as Record<string, unknown>).path as string | undefined
                    if (targetPath && ignoreMatcher.isIgnored(targetPath)) {
                        const msg = `ACCESS BLOCKED: "${targetPath}" is excluded by .brainwaveignore.`
                        toolResults.push({ tool: internalKey, success: false, content: msg })
                        resultBlocks.push(createToolResult(toolUse.id, msg, true))
                        continue
                    }
                }

                // Approval gate
                const approvalSettings = agent.getApprovalSettings()
                const mcpAutoApproved = registry.isToolAutoApproved(internalKey)
                if (requiresApproval(internalKey, approvalSettings, mcpAutoApproved)) {
                    const approval = await requestApproval(
                        context.taskId,
                        agent.type,
                        internalKey,
                        toolUse.input,
                    )
                    if (!approval.approved) {
                        const rejectMsg = `Rejected by user.${approval.reason ? ` Reason: ${approval.reason}` : ''}`
                        toolResults.push({ tool: internalKey, success: false, content: rejectMsg })
                        resultBlocks.push(createToolResult(toolUse.id, rejectMsg, true))
                        continue
                    }
                }

                // Execute the tool
                console.log(`[${agent.type}] Step ${step}: ${internalKey} args=${JSON.stringify(toolUse.input).slice(0, 200)}`)
                const toolStartTime = Date.now()

                const toolBaseName = internalKey.split('::').pop() ?? internalKey
                const result = internalKey.startsWith('local::')
                    ? await localProvider.callTool(toolBaseName, toolUse.input, { taskId: context.taskId })
                    : await registry.callTool(internalKey, toolUse.input)

                const toolDuration = Date.now() - toolStartTime
                console.log(`[${agent.type}] Step ${step}: ${internalKey} → ${result.success ? 'OK' : 'FAIL'} (${toolDuration}ms)`)

                toolResults.push({
                    tool: internalKey,
                    success: result.success,
                    content: result.content,
                })

                // Build tool_result block
                resultBlocks.push(createToolResult(toolUse.id, result.content, !result.success))

                // Emit tool result for UI
                const summary = summarizeForUI(internalKey, toolUse.input, result)
                agent.bus.emitEvent('agent:tool-result', {
                    agentType: agent.type,
                    taskId: context.taskId,
                    tool: internalKey,
                    success: result.success,
                    summary,
                    step,
                })
                emitToolCallInfo(agent.bus, agent.type, {
                    taskId: context.taskId,
                    step,
                    tool: internalKey,
                    args: toolUse.input,
                    success: result.success,
                    summary,
                    duration: toolDuration,
                    resultPreview: result.content.slice(0, 300),
                })

                // File registry tracking
                const isReadOp = ['file_read', 'directory_list', 'read_file'].includes(toolBaseName)
                const readPath = (toolUse.input as Record<string, unknown>).path as string | undefined
                if (result.success && isReadOp && readPath) {
                    fileRegistry.set(normPath(readPath), { content: result.content, step })
                    fileTracker.trackFileRead(readPath, step)
                }
                const isWriteOp = ['file_edit', 'file_write', 'file_create'].includes(toolBaseName)
                if (result.success && isWriteOp && readPath) {
                    fileTracker.trackFileEdit(readPath, step)
                }

                // Dynamic tool expansion: when discover_tools loads new tools,
                // rebuild the tool list so subsequent API calls include them
                if (toolBaseName === 'discover_tools' && result.success) {
                    rebuildToolList()
                }

                // Artifact tracking
                artifacts.push({
                    type: 'json',
                    name: `tool-${toolBaseName}-step${step}`,
                    content: JSON.stringify(result, null, 2),
                })
            }

            // ── Add all tool results as a single user message ──
            if (resultBlocks.length > 0) {
                conversation.addNativeToolResults(resultBlocks as ToolResultBlock[])
            }

            // ── Context usage reporting (every 5 steps) ──
            if (step % 5 === 0) {
                const ctxSummary = conversation.getContextSummary()
                console.log(
                    `[${agent.type}] Step ${step}: Context ${ctxSummary.usagePercent}% ` +
                    `(${formatTokenCount(ctxSummary.tokensUsed)} / ${formatTokenCount(ctxSummary.budgetTotal)})`
                )
            }
        }

        // Safety valve — max steps reached
        const anySuccess = toolResults.some(t => t.success)
        return agent.buildToolResult(
            anySuccess ? 'partial' : 'failed',
            `Safety limit reached (${ABSOLUTE_MAX_STEPS} steps).`,
            anySuccess ? 0.5 : 0.2,
            totalTokensIn, totalTokensOut, model, startTime, artifacts,
        )
    } catch (err) {
        if (CancellationError.is(err) || (err instanceof Error && err.name === 'AbortError')) {
            const anySuccess = toolResults.some(t => t.success)
            return agent.buildToolResult(
                anySuccess ? 'partial' : 'failed',
                anySuccess ? 'Task cancelled. Partial results available.' : 'Task cancelled.',
                anySuccess ? 0.4 : 0.1,
                totalTokensIn, totalTokensOut, model, startTime, artifacts,
            )
        }

        const error = err instanceof Error ? err.message : String(err)
        agent.bus.emitEvent('agent:error', {
            agentType: agent.type,
            taskId: context.taskId,
            error,
        })
        return agent.buildToolResult(
            'failed', null, 0,
            totalTokensIn, totalTokensOut, model, startTime, artifacts, error,
        )
    }
}
