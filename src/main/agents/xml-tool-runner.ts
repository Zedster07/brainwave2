/**
 * XML Tool Runner — Legacy tool calling loop (XML protocol)
 *
 * Extracted from BaseAgent.executeWithTools().
 * Handles the agentic loop for models that do not support native tool calling
 * or when explicit XML protocol is preferred.
 *
 * Features:
 * - XML parser for tool calls (<tool>...</tool>)
 * - Multi-turn conversation management
 * - Streaming response handling with live UI updates
 * - Integrated condensation and file context tracking
 * - Delegation support (sub-agents)
 */
import { readFile as fsReadFile } from 'fs/promises'
import { LLMFactory, type LLMRequest, type LLMResponse, type ConversationMessage } from '../llm'
import {
    getModelCapabilities,
    createToolResult,
} from '../llm/types'
import { summarizeForUI, emitToolCallInfo } from './ui-helpers'
import { parseToolCall, parseDoneSignal } from './response-parsers'
import { performCondensation } from './condensation'
import { executeWithNativeTools } from './native-tool-runner'
import type { AgentType } from './event-bus'
import { getPromptRegistry } from '../prompts'
import { calculateBudget, formatTokenCount, countTokens, MAX_INPUT_BUDGET } from '../llm/token-counter'
import { type FileRegistryEntry, compactContext, buildCompactionNotice } from './context-compactor'
import { FileContextTracker } from './file-context-tracker'
import { getMcpRegistry } from '../mcp'
import { getLocalToolProvider } from '../tools'
import { getAgentPermissions, filterToolsForAgent, filterToolsForMode, canAgentCallTool } from '../tools/permissions'
import { getModeRegistry } from '../modes'
import { canDelegate, canDelegateAtDepth } from './delegation'
import { CancellationError } from './cancellation'
import { requiresApproval, requestApproval, type ApprovalSettings } from '../tools/approval'
import { parseAssistantMessage, xmlToolToLocalCall } from './xml-parser'
import { extractToolsFromProse } from './prose-tool-extractor'
import { ConversationManager } from './conversation-manager'
import { getCheckpointService } from './checkpoint-service'
import { detectWorkspace, getEnvironmentDetails } from './environment'
import { getInstructionManager } from '../instructions'
import { getSoftEngine } from '../rules'
import {
    ToolRepetitionDetector,
    createMistakeCounters,
    recordFileError,
    buildDiffFallbackMessage,
    GRACE_RETRY_THRESHOLD,
    MAX_GENERAL_MISTAKES,
    type MistakeCounters,
} from './tool-repetition-detector'

import type { SubTask, AgentContext, AgentResult, Artifact, BaseAgentHandle } from './types'

// ─── Main Executor ──────────────────────────────────────────────────────────

/**
 * Execute a task using the agentic tool loop (XML protocol + multi-turn conversation).
 */
export async function executeWithTools(
    agent: BaseAgentHandle,
    task: SubTask,
    context: AgentContext
): Promise<AgentResult> {
    // ── Route to native tool calling if model supports it ──
    const nativeModelConfig = LLMFactory.getAgentConfig(agent.type)
    if (nativeModelConfig?.useNativeTools) {
        const caps = getModelCapabilities(nativeModelConfig.model ?? '')
        if (caps.supportsNativeTools) {
            console.log(`[${agent.type}] Routing to native tool calling (model=${nativeModelConfig.model})`)
            return executeWithNativeTools(agent, task, context)
        }
    }

    const startTime = Date.now()
    const modelConfig = LLMFactory.getAgentConfig(agent.type)
    const permConfig = getAgentPermissions(agent.type)
    const registry = getMcpRegistry()
    const localProvider = getLocalToolProvider()

    // Get only the tools this agent is allowed to use
    const allTools = [...localProvider.getTools(), ...registry.getAllTools()]
    const modeConfig = context.mode ? getModeRegistry().get(context.mode) : undefined
    const allowedTools = modeConfig
        ? filterToolsForMode(modeConfig, allTools)
        : filterToolsForAgent(agent.type, allTools)

    // If no tools available, fall back to single LLM call (think)
    // Note: We don't have access to agent.think(), so we use LLMFactory directly
    if (allowedTools.length === 0) {
        console.log(`[${agent.type}] executeWithTools: No tools available, falling back to simple completion`)
        const adapter = LLMFactory.getForAgent(agent.type)
        const systemPrompt = await agent.getSystemPrompt(context)
        const response = await adapter.complete({
            model: modelConfig?.model,
            system: systemPrompt,
            user: task.description,
            temperature: modelConfig?.temperature,
            maxTokens: modelConfig?.maxTokens,
        })

        return {
            status: 'success',
            output: response.content,
            confidence: 0.8, // Simple fallback
            tokensIn: response.tokensIn,
            tokensOut: response.tokensOut,
            model: response.model,
            duration: Date.now() - startTime,
        }
    }

    agent.bus.emitEvent('agent:thinking', {
        agentType: agent.type,
        taskId: context.taskId,
        model: modelConfig?.model ?? 'unknown',
    })

    let totalTokensIn = 0
    let totalTokensOut = 0
    let model = modelConfig?.model ?? 'unknown'
    const artifacts: Artifact[] = []
    const toolResults: Array<{ tool: string; success: boolean; content: string }> = []

    // Loop detection & safety constants
    const TIMEOUT_MS = permConfig.timeoutMs ?? 5 * 60 * 1000
    const MAX_LOOP_REPEATS = 3
    const MAX_TOOL_FREQUENCY = 8
    const MAX_READ_TOOL_FREQUENCY = 30
    const MAX_CONSECUTIVE_SAME = 5
    const ABSOLUTE_MAX_STEPS = 100
    const SOFT_WARNING_STEP = 50
    const READ_ONLY_TOOLS = new Set(['file_read', 'read_text_file', 'read_file', 'directory_list', 'list_directory', 'list_allowed_directories', 'search_files', 'grep_search'])
    const toolCallHistory: Array<{ tool: string; argsHash: string }> = []
    const toolFrequency: Map<string, number> = new Map()        // tracks tool+args combos
    const toolNameFrequency: Map<string, number> = new Map()    // tracks tool name only
    let stuckWarningGiven = false

    const repetitionDetector = new ToolRepetitionDetector(3)
    const mistakes: MistakeCounters = createMistakeCounters()

    // File registry for smart dedup & content tracking
    const fileRegistry = new Map<string, FileRegistryEntry>()
    const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase()
    const getReadPath = (args: Record<string, unknown>): string | null =>
        (args.path as string) ?? (args.file_path as string) ?? null

    // File context tracker
    const fileTracker = new FileContextTracker()
    let condensationPending = false

    const checkpointService = getCheckpointService()

    // Resolve working directory
    const workDir = context.workDir
        ?? detectWorkspace(task.description, context.parentTask, agent.getBrainwaveHomeDir())

    // .brainwaveignore
    const instructionMgr = getInstructionManager()
    const ignoreMatcher = await instructionMgr.getIgnoreMatcher(workDir)
    const customInstructionBlock = await instructionMgr.buildBlock({
        workDir,
        mode: context.mode,
    })

    // Initialize conversation manager
    const rawContextLimit = calculateBudget(model, 0).contextLimit
    const contextLimit = Math.min(rawContextLimit, MAX_INPUT_BUDGET)
    const conversation = new ConversationManager(contextLimit, 8_000)

    console.log(`[${agent.type}] executeWithTools | taskId=${context.taskId} | model=${model} | tools=${allowedTools.length} | timeout=${Math.round(TIMEOUT_MS / 1000)}s | contextLimit=${formatTokenCount(contextLimit)}`)

    try {
        // ─── Build initial context ───
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
                priorContext = `\n\nPRIOR STEPS ALREADY COMPLETED (use this context — do NOT redo these):\n${priorLines.join('\n')}\n`
            }
        }

        const parentContext = context.parentTask
            ? `\nORIGINAL USER REQUEST: "${context.parentTask}"\n`
            : ''

        let historyContext = ''
        if (context.conversationHistory && context.conversationHistory.length > 0) {
            const recent = context.conversationHistory.slice(-6)
            const lines = recent.map((msg) =>
                `${msg.role === 'user' ? 'User' : 'Brainwave'}: ${msg.content}`
            ).join('\n')
            historyContext = `\n\nRECENT CONVERSATION (use this to understand references like "try again", "do that", etc.):\n${lines}\n`
        }

        let blackboardContext = ''
        if (context.blackboard) {
            blackboardContext = context.blackboard.board.formatForPrompt(
                context.blackboard.planId,
                agent.type,
                context.taskId
            )
        }

        const envDetails = await getEnvironmentDetails({
            workDir,
            brainwaveHomeDir: agent.getBrainwaveHomeDir(),
            contextLimitTokens: contextLimit,
            fileTracker,
            includeTree: true,
            treeMaxDepth: 3,
            treeMaxEntries: 200,
        })

        const initialMessage =
            `TASK: ${task.description}\n${parentContext}${historyContext}${priorContext}${blackboardContext}\n${envDetails}\n` +
            `Begin working on this task. Use the XML tool protocol to call tools.\n` +
            `For file/directory operations, use local:: tools (e.g. local::file_read, local::file_write, local::create_directory).\n` +
            `When done, use <attempt_completion> to signal completion with your final answer.`

        conversation.addMessage('user', initialMessage)

        let step = 0
        let loopDetected = false

        while (step < ABSOLUTE_MAX_STEPS) {
            step++

            // ── Cancellation check ──
            if (context.cancellationToken?.isCancelled) {
                console.log(`[${agent.type}] Cancelled at step ${step}`)
                const anySuccess = toolResults.some((t) => t.success)
                agent.bus.emitEvent('agent:error', {
                    agentType: agent.type,
                    taskId: context.taskId,
                    error: 'Task cancelled by user',
                })
                return buildToolResult(
                    'failed',
                    anySuccess
                        ? `Task cancelled after ${step - 1} step(s). Partial results:\n` +
                        toolResults.filter(t => t.success).slice(-3).map(t => `${t.tool}: ${t.content.slice(0, 200)}`).join('\n')
                        : 'Task cancelled by user before any results were obtained.',
                    anySuccess ? 0.4 : 0.1,
                    totalTokensIn, totalTokensOut, model, startTime, artifacts
                )
            }

            // ── Timeout check ──
            if (Date.now() - startTime > TIMEOUT_MS) {
                const anySuccess = toolResults.some((t) => t.success)
                agent.bus.emitEvent('agent:error', {
                    agentType: agent.type,
                    taskId: context.taskId,
                    error: `Timed out after ${Math.round((Date.now() - startTime) / 1000)}s`,
                })
                return buildToolResult(
                    anySuccess ? 'partial' : 'failed',
                    `Timed out after ${Math.round((Date.now() - startTime) / 1000)}s. ` +
                    (toolResults.length > 0
                        ? `Completed ${toolResults.length} tool call(s). Last results:\n` +
                        toolResults.slice(-2).map((t) => `${t.tool}: ${t.content}`).join('\n')
                        : 'No tool calls completed.'),
                    anySuccess ? 0.5 : 0.2,
                    totalTokensIn, totalTokensOut, model, startTime, artifacts
                )
            }

            agent.bus.emitEvent('agent:acting', {
                agentType: agent.type,
                taskId: context.taskId,
                action: `Step ${step}: ${step === 1 ? 'Analyzing task...' : 'Deciding next action...'}`,
            })

            // ── Condensation ──
            if (condensationPending) {
                condensationPending = false
                console.log(`[${agent.type}] Step ${step}: Condense tool triggered — performing LLM condensation`)
                await performCondensation(conversation, context, agent.type, fileRegistry, fileTracker, agent.bus)
            }

            if (step > 1 && conversation.isNearBudget(0.75)) {
                console.log(`[${agent.type}] Step ${step}: Near budget (75%) — triggering LLM condensation`)
                await performCondensation(conversation, context, agent.type, fileRegistry, fileTracker, agent.bus)

                if (conversation.isNearBudget(0.90)) {
                    const targetFree = Math.floor(conversation.getTokenCount() * 0.25)
                    const compactionResult = compactContext(fileRegistry, toolResults, targetFree, step)
                    if (compactionResult.tokensFreed > 0) {
                        fileRegistry.clear()
                        for (const [k, v] of compactionResult.fileRegistry) {
                            fileRegistry.set(k, v)
                        }
                        conversation.addSystemNotice(buildCompactionNotice(compactionResult))
                        console.log(`[${agent.type}] Heuristic compaction: ${compactionResult.summary}`)
                    }
                }
            }

            // ── LLM Call ──
            const response = await streamWithHistory(
                agent,
                conversation.getMessages(),
                context,
                {
                    temperature: modelConfig?.temperature ?? 0.1,
                    maxTokens: modelConfig?.maxTokens,
                },
                customInstructionBlock || undefined,
            )

            totalTokensIn += response.tokensIn
            totalTokensOut += response.tokensOut
            model = response.model

            conversation.addMessage('assistant', response.content)

            // ── Parse ──
            const parsed = parseAssistantMessage(response.content)

            // Emit reasoning
            if (parsed.textContent) {
                const reasoning = parsed.textContent.slice(0, 200).replace(/\n+/g, ' ').trim()
                if (reasoning.length > 10) {
                    agent.bus.emitEvent('agent:acting', {
                        agentType: agent.type,
                        taskId: context.taskId,
                        action: `💭 ${reasoning.slice(0, 150)}`,
                    })
                }
            }

            // ── Completion ──
            if (parsed.completionResult) {
                console.log(`[${agent.type}] Completion at step ${step}: "${parsed.completionResult.slice(0, 200)}..."`)
                const anySuccess = toolResults.some((t) => t.success)

                if (context.blackboard) {
                    context.blackboard.board.write(
                        context.blackboard.planId,
                        'final-summary',
                        parsed.completionResult,
                        agent.type,
                        context.taskId
                    )
                }

                agent.bus.emitEvent('agent:completed', {
                    agentType: agent.type,
                    taskId: context.taskId,
                    confidence: anySuccess ? 0.9 : 0.7,
                    tokensIn: totalTokensIn,
                    tokensOut: totalTokensOut,
                    toolsCalled: toolResults.map((t) => t.tool),
                })

                return buildToolResult(
                    anySuccess ? 'success' : (toolResults.length > 0 ? 'partial' : 'success'),
                    parsed.completionResult,
                    anySuccess ? 0.9 : 0.7,
                    totalTokensIn, totalTokensOut, model, startTime, artifacts
                )
            }

            // ── JSON Done Signal (Legacy) ──
            const jsonDoneSignal = parseDoneSignal(response.content, agent.type)
            if (jsonDoneSignal) {
                const anySuccess = toolResults.some((t) => t.success)
                return buildToolResult(
                    anySuccess ? 'success' : (toolResults.length > 0 ? 'partial' : 'success'),
                    jsonDoneSignal,
                    anySuccess ? 0.9 : 0.7,
                    totalTokensIn, totalTokensOut, model, startTime, artifacts
                )
            }

            // ── Process Tools ──
            if (parsed.toolUses.length > 0) {
                const READ_OP_NAMES = new Set(['file_read', 'directory_list', 'read_file', 'read_multiple_files', 'search_files', 'list_code_definition_names'])

                // Parallel read optimization
                if (parsed.toolUses.length > 1) {
                    const allCalls = parsed.toolUses.map(xu => xmlToolToLocalCall(xu))
                    const allReadOnly = allCalls.every(c => READ_OP_NAMES.has(c.tool.split('::').pop() ?? c.tool))

                    if (allReadOnly) {
                        const batchResults = await Promise.all(allCalls.map(async (tc) => {
                            const perm = canAgentCallTool(agent.type, tc.tool)
                            if (!perm.allowed) {
                                return { tool: tc.tool, success: false, content: `PERMISSION DENIED: ${perm.reason}` }
                            }
                            // .brainwaveignore check
                            if (ignoreMatcher.hasPatterns) {
                                const tp = getReadPath(tc.args)
                                if (tp && ignoreMatcher.isIgnored(tp)) {
                                    return { tool: tc.tool, success: false, content: `ACCESS BLOCKED by .brainwaveignore` }
                                }
                            }
                            // Cache check
                            const rp = getReadPath(tc.args)
                            const nr = rp ? normPath(rp) : null
                            const cached = nr ? fileRegistry.get(nr) : null
                            if (cached) {
                                return { tool: tc.tool, success: true, content: cached.content }
                            }
                            // Execute
                            const res = tc.tool.startsWith('local::')
                                ? await localProvider.callTool(tc.tool.split('::')[1], tc.args, { taskId: context.taskId })
                                : await registry.callTool(tc.tool, tc.args)

                            if (res.success && rp) {
                                fileRegistry.set(normPath(rp), { content: res.content, step })
                                fileTracker.trackFileRead(rp, step)
                            }
                            return { tool: tc.tool, success: res.success, content: res.content }
                        }))

                        for (const br of batchResults) {
                            toolResults.push(br)
                            toolCallHistory.push({ tool: br.tool, argsHash: JSON.stringify({}) })
                            const brSummary = br.success ? `Read ${br.content.split('\n').length} lines` : br.content.slice(0, 100)

                            agent.bus.emitEvent('agent:tool-result', {
                                agentType: agent.type,
                                taskId: context.taskId,
                                tool: br.tool,
                                success: br.success,
                                summary: brSummary,
                                step,
                            })
                            emitToolCallInfo(agent.bus, agent.type, {
                                taskId: context.taskId, step, tool: br.tool,
                                args: {}, success: br.success, summary: brSummary,
                                resultPreview: br.content.slice(0, 300),
                            })
                        }
                        conversation.addToolResults(batchResults)
                        continue
                    }
                }

                // Sequential processing
                const xmlToolUse = parsed.toolUses[0]
                const toolCall = xmlToolToLocalCall(xmlToolUse)
                const toolBaseName = toolCall.tool.split('::').pop() ?? toolCall.tool
                const argsHash = JSON.stringify(toolCall.args ?? {})

                // Permission check
                const perm = canAgentCallTool(agent.type, toolCall.tool)
                if (!perm.allowed) {
                    toolResults.push({ tool: toolCall.tool, success: false, content: `PERMISSION DENIED: ${perm.reason}` })
                    conversation.addToolResult(toolCall.tool, false, `PERMISSION DENIED: ${perm.reason}`)
                    continue
                }

                // Ignore check
                if (ignoreMatcher.hasPatterns) {
                    const targetPath = getReadPath(toolCall.args)
                    if (targetPath && ignoreMatcher.isIgnored(targetPath)) {
                        const msg = `ACCESS BLOCKED: "${targetPath}" is excluded by .brainwaveignore.`
                        toolResults.push({ tool: toolCall.tool, success: false, content: msg })
                        conversation.addToolResult(toolCall.tool, false, msg)
                        continue
                    }
                }

                // Duplicate read interception
                const isReadOp = ['file_read', 'directory_list', 'read_file', 'read_multiple_files'].includes(toolBaseName)
                if (isReadOp) {
                    const readPath = getReadPath(toolCall.args)
                    const normalizedRead = readPath ? normPath(readPath) : null
                    const cachedFile = normalizedRead ? fileRegistry.get(normalizedRead) : null

                    if (cachedFile) {
                        let excerpt = cachedFile.content
                        // Handle line ranges...
                        const startLine = toolCall.args.start_line as number | undefined
                        const endLine = toolCall.args.end_line as number | undefined
                        if (startLine || endLine) {
                            const lines = cachedFile.content.split('\n')
                            const s = Math.max(0, (startLine ?? 1) - 1)
                            const e = Math.min(lines.length, endLine ?? lines.length)
                            excerpt = `[Lines ${s + 1}-${e} of ${lines.length} total]\n` + lines.slice(s, e).join('\n')
                        }

                        toolResults.push({ tool: toolCall.tool, success: true, content: excerpt })
                        conversation.addToolResult(toolCall.tool, true, excerpt)

                        const cacheSummary = `Read from cache (${cachedFile.content.split('\n').length} lines)`
                        emitToolCallInfo(agent.bus, agent.type, {
                            taskId: context.taskId, step, tool: toolCall.tool,
                            args: toolCall.args, success: true, summary: cacheSummary,
                            duration: 0, resultPreview: excerpt.slice(0, 300),
                        })
                        continue
                    }
                }

                // Loop detection
                toolCallHistory.push({ tool: toolCall.tool, argsHash })
                const callKey = `${toolBaseName}::${argsHash}`
                const freq = (toolFrequency.get(callKey) ?? 0) + 1
                toolFrequency.set(callKey, freq)
                const nameFreq = (toolNameFrequency.get(toolBaseName) ?? 0) + 1
                toolNameFrequency.set(toolBaseName, nameFreq)

                const repCheck = repetitionDetector.check({ tool: toolCall.tool, args: toolCall.args ?? {} })
                if (repCheck.isRepetition) {
                    loopDetected = true
                    console.warn(`[${agent.type}] Loop detected (repetition detector): "${toolBaseName}" called ${repCheck.count}×`)
                    break
                }

                const isReadOnly = READ_ONLY_TOOLS.has(toolBaseName)
                const effectiveLimit = isReadOnly ? MAX_READ_TOOL_FREQUENCY : MAX_TOOL_FREQUENCY
                const effectiveFreq = isReadOnly ? nameFreq : freq

                if (effectiveFreq >= effectiveLimit) {
                    if (!stuckWarningGiven) {
                        stuckWarningGiven = true
                        toolResults.push({ tool: toolCall.tool, success: false, content: `STUCK DETECTION: You called "${toolBaseName}" ${effectiveFreq} times.` })
                        conversation.addSystemNotice(`You have called "${toolBaseName}" ${effectiveFreq} times. You may be looping.`)
                        continue
                    }
                    loopDetected = true
                    break
                }

                if (mistakes.general >= MAX_GENERAL_MISTAKES) {
                    loopDetected = true
                    break
                }

                // Delegation
                if (toolCall.tool === 'delegate_to_agent' || xmlToolUse.tool === 'delegate_to_agent') {
                    const targetAgent = (toolCall.args?.agent ?? xmlToolUse.params.agent) as AgentType | undefined
                    const delegatedTask = (toolCall.args?.task ?? xmlToolUse.params.task) as string | undefined

                    if (!targetAgent || !delegatedTask) {
                        toolResults.push({ tool: 'delegate_to_agent', success: false, content: 'INVALID ARGS: requires agent and task parameters' })
                        conversation.addToolResult('delegate_to_agent', false, 'INVALID ARGS: requires agent and task parameters')
                    } else if (!context.delegateFn) {
                        toolResults.push({ tool: 'delegate_to_agent', success: false, content: 'DELEGATION UNAVAILABLE in this context' })
                        conversation.addToolResult('delegate_to_agent', false, 'DELEGATION UNAVAILABLE in this context')
                    } else if (!canDelegateAtDepth(context.delegationDepth ?? 0)) {
                        toolResults.push({ tool: 'delegate_to_agent', success: false, content: 'DELEGATION DEPTH EXCEEDED' })
                        conversation.addToolResult('delegate_to_agent', false, 'DELEGATION DEPTH EXCEEDED — complete the task yourself')
                    } else {
                        const delegationPerm = canDelegate(agent.type, targetAgent)
                        if (!delegationPerm.allowed) {
                            toolResults.push({ tool: 'delegate_to_agent', success: false, content: `DELEGATION DENIED: ${delegationPerm.reason}` })
                            conversation.addToolResult('delegate_to_agent', false, `DELEGATION DENIED: ${delegationPerm.reason}`)
                        } else {
                            console.log(`[${agent.type}] Step ${step}: Delegating to ${targetAgent}: "${delegatedTask.slice(0, 150)}"`)
                            agent.bus.emitEvent('agent:acting', {
                                agentType: agent.type,
                                taskId: context.taskId,
                                action: `Delegating to ${targetAgent} (step ${step})`,
                            })

                            try {
                                const delegationResult = await context.delegateFn(targetAgent, delegatedTask)
                                const outputStr = typeof delegationResult.output === 'string'
                                    ? delegationResult.output
                                    : JSON.stringify(delegationResult.output)
                                const delegSuccess = delegationResult.status === 'success' || delegationResult.status === 'partial'

                                toolResults.push({ tool: `delegate_to_agent:${targetAgent}`, success: delegSuccess, content: outputStr })
                                totalTokensIn += delegationResult.tokensIn
                                totalTokensOut += delegationResult.tokensOut

                                conversation.addToolResult(`delegate_to_agent:${targetAgent}`, delegSuccess, outputStr)

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
                                        status: delegationResult.status,
                                        confidence: delegationResult.confidence,
                                        output: outputStr,
                                    }, null, 2),
                                })
                            } catch (err) {
                                const errMsg = `DELEGATION FAILED: ${err instanceof Error ? err.message : String(err)}`
                                toolResults.push({ tool: `delegate_to_agent:${targetAgent}`, success: false, content: errMsg })
                                conversation.addToolResult(`delegate_to_agent:${targetAgent}`, false, errMsg)
                            }
                        }
                    }

                    const delegSummary = toolResults[toolResults.length - 1].success
                        ? `Delegated to ${targetAgent ?? 'agent'} — completed`
                        : `Delegation to ${targetAgent ?? 'agent'} failed`
                    agent.bus.emitEvent('agent:tool-result', {
                        agentType: agent.type,
                        taskId: context.taskId,
                        tool: toolResults[toolResults.length - 1].tool,
                        success: toolResults[toolResults.length - 1].success,
                        summary: delegSummary,
                        step,
                    })
                    emitToolCallInfo(agent.bus, agent.type, {
                        taskId: context.taskId, step,
                        tool: toolResults[toolResults.length - 1].tool,
                        args: toolCall.args, success: toolResults[toolResults.length - 1].success,
                        summary: delegSummary,
                        resultPreview: toolResults[toolResults.length - 1].content.slice(0, 300),
                    })
                    continue
                }

                // Handle parallel delegation (use_subagents)
                if (toolCall.tool === 'use_subagents' || xmlToolUse.tool === 'use_subagents') {
                    const tasksRaw = toolCall.args?.tasks ?? xmlToolUse.params.tasks
                    let parsedTasks: Array<{ agent: string; task: string }> = []

                    // Parse tasks from JSON string or array
                    try {
                        if (typeof tasksRaw === 'string') {
                            parsedTasks = JSON.parse(tasksRaw)
                        } else if (Array.isArray(tasksRaw)) {
                            parsedTasks = tasksRaw as Array<{ agent: string; task: string }>
                        }
                    } catch {
                        toolResults.push({ tool: 'use_subagents', success: false, content: 'INVALID ARGS: tasks must be a valid JSON array of { agent, task } objects' })
                        conversation.addToolResult('use_subagents', false, 'INVALID ARGS: tasks must be a valid JSON array of { agent, task } objects')
                        continue
                    }

                    if (!Array.isArray(parsedTasks) || parsedTasks.length === 0) {
                        toolResults.push({ tool: 'use_subagents', success: false, content: 'INVALID ARGS: tasks must be a non-empty array' })
                        conversation.addToolResult('use_subagents', false, 'INVALID ARGS: tasks must be a non-empty array')
                        continue
                    }

                    if (!context.parallelDelegateFn) {
                        toolResults.push({ tool: 'use_subagents', success: false, content: 'PARALLEL DELEGATION UNAVAILABLE in this context' })
                        conversation.addToolResult('use_subagents', false, 'PARALLEL DELEGATION UNAVAILABLE in this context')
                        continue
                    }

                    if (!canDelegateAtDepth(context.delegationDepth ?? 0)) {
                        toolResults.push({ tool: 'use_subagents', success: false, content: 'DELEGATION DEPTH EXCEEDED' })
                        conversation.addToolResult('use_subagents', false, 'DELEGATION DEPTH EXCEEDED — complete the tasks yourself')
                        continue
                    }

                    // Validate each task's agent permission
                    const validatedTasks: Array<{ agent: AgentType; task: string }> = []
                    const rejections: string[] = []
                    for (const t of parsedTasks.slice(0, 5)) { // Cap at 5
                        const perm = canDelegate(agent.type, t.agent as AgentType)
                        if (!perm.allowed) {
                            rejections.push(`"${t.agent}": ${perm.reason}`)
                        } else {
                            validatedTasks.push({ agent: t.agent as AgentType, task: t.task })
                        }
                    }

                    if (validatedTasks.length === 0) {
                        const msg = `ALL DELEGATIONS DENIED:\n${rejections.join('\n')}`
                        toolResults.push({ tool: 'use_subagents', success: false, content: msg })
                        conversation.addToolResult('use_subagents', false, msg)
                        continue
                    }

                    console.log(`[${agent.type}] Step ${step}: Parallel delegation → ${validatedTasks.length} sub-agents: ${validatedTasks.map(t => t.agent).join(', ')}`)
                    agent.bus.emitEvent('agent:acting', {
                        agentType: agent.type,
                        taskId: context.taskId,
                        action: `Parallel delegation: ${validatedTasks.length} sub-agents (step ${step})`,
                    })

                    try {
                        const results = await context.parallelDelegateFn(validatedTasks)

                        // Build combined result
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

                        const combinedResult = resultParts.join('\n\n')
                        toolResults.push({ tool: 'use_subagents', success: allSuccess, content: combinedResult })
                        conversation.addToolResult('use_subagents', allSuccess, combinedResult)

                        if (rejections.length > 0) {
                            conversation.addSystemNotice(`Note: ${rejections.length} sub-task(s) were skipped due to permission rules:\n${rejections.join('\n')}`)
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
                        const errMsg = `PARALLEL DELEGATION FAILED: ${err instanceof Error ? err.message : String(err)}`
                        toolResults.push({ tool: 'use_subagents', success: false, content: errMsg })
                        conversation.addToolResult('use_subagents', false, errMsg)
                    }

                    const parSummary = toolResults[toolResults.length - 1].success
                        ? `Parallel delegation (${validatedTasks.length} agents) — completed`
                        : `Parallel delegation failed`
                    agent.bus.emitEvent('agent:tool-result', {
                        agentType: agent.type,
                        taskId: context.taskId,
                        tool: 'use_subagents',
                        success: toolResults[toolResults.length - 1].success,
                        summary: parSummary,
                        step,
                    })
                    emitToolCallInfo(agent.bus, agent.type, {
                        taskId: context.taskId, step, tool: 'use_subagents',
                        args: toolCall.args, success: toolResults[toolResults.length - 1].success,
                        summary: parSummary,
                        resultPreview: toolResults[toolResults.length - 1].content.slice(0, 300),
                    })
                    continue
                }

                // Execute generic tool
                const approvalSettings = agent.getApprovalSettings()
                const mcpAutoApproved = registry.isToolAutoApproved(toolCall.tool)
                if (requiresApproval(toolCall.tool, approvalSettings, mcpAutoApproved)) {
                    console.log(`[${agent.type}] Approval required for ${toolCall.tool}`)
                    const approval = await requestApproval(context.taskId, agent.type, toolCall.tool, toolCall.args)
                    if (!approval.approved) {
                        conversation.addToolResult(toolCall.tool, false, `Rejected by user.`)
                        continue
                    }
                }

                const toolStartTime = Date.now()
                let result
                try {
                    result = toolCall.tool.startsWith('local::')
                        ? await localProvider.callTool(toolCall.tool.split('::')[1], toolCall.args, { taskId: context.taskId })
                        : await registry.callTool(toolCall.tool, toolCall.args)
                } catch (err) {
                    result = { success: false, content: String(err) }
                }
                const toolDuration = Date.now() - toolStartTime

                toolResults.push({ tool: toolCall.tool, success: result.success, content: result.content })
                conversation.addToolResult(toolCall.tool, result.success, result.content)

                // Cache update
                if (result.success && isReadOp) {
                    const readPath = getReadPath(toolCall.args)
                    if (readPath && (!toolCall.args.start_line && !toolCall.args.end_line)) {
                        fileRegistry.set(normPath(readPath), { content: result.content, step })
                        fileTracker.trackFileRead(readPath, step)
                    }
                }
                const isWriteOp = ['file_edit', 'file_write', 'file_create'].includes(toolBaseName)
                if (result.success && isWriteOp) {
                    const writePath = getReadPath(toolCall.args)
                    if (writePath) {
                        try {
                            const fresh = await fsReadFile(writePath, 'utf-8')
                            fileRegistry.set(normPath(writePath), { content: fresh, step })
                        } catch {
                            fileRegistry.delete(normPath(writePath))
                        }
                        fileTracker.trackFileEdit(writePath, step)
                        // Trigger checkpoint
                        checkpointService.createCheckpoint(workDir, context.taskId, step, toolBaseName, writePath)
                            .catch(console.warn)
                    }
                }

                if (toolBaseName === 'condense') condensationPending = true

                const mainSummary = summarizeForUI(toolCall.tool, toolCall.args, result)
                agent.bus.emitEvent('agent:tool-result', {
                    agentType: agent.type,
                    taskId: context.taskId,
                    tool: toolCall.tool,
                    success: result.success,
                    summary: mainSummary,
                    step,
                })
                emitToolCallInfo(agent.bus, agent.type, {
                    taskId: context.taskId, step, tool: toolCall.tool,
                    args: toolCall.args, success: result.success, summary: mainSummary,
                    duration: toolDuration,
                    resultPreview: result.content.slice(0, 300),
                })
                continue
            }

            // ── Fallback Parsing (JSON/Prose) ──
            const jsonToolCall = parseToolCall(response.content, agent.type)
            if (jsonToolCall) {
                console.log(`[${agent.type}] Step ${step}: Parsed JSON tool call (legacy): ${jsonToolCall.tool}`)
                // Re-inject as a nudge to use XML format, but also execute it
                const toolBaseName = jsonToolCall.tool.split('::').pop() ?? jsonToolCall.tool
                const perm = canAgentCallTool(agent.type, jsonToolCall.tool)

                if (perm.allowed) {
                    const jsonStartTime = Date.now()
                    const result = jsonToolCall.tool.startsWith('local::')
                        ? await localProvider.callTool(jsonToolCall.tool.split('::')[1], jsonToolCall.args)
                        : await registry.callTool(jsonToolCall.tool, jsonToolCall.args)
                    const jsonDuration = Date.now() - jsonStartTime

                    toolResults.push({ tool: jsonToolCall.tool, success: result.success, content: result.content })
                    conversation.addToolResult(jsonToolCall.tool, result.success,
                        result.content + '\n\nNote: Please use the XML tool format for future tool calls. Example:\n<read_file>\n<path>/path/to/file</path>\n</read_file>')

                    // Update file registry
                    if (result.success) {
                        const isReadOp = ['file_read', 'directory_list', 'read_file'].includes(toolBaseName)
                        if (isReadOp) {
                            const readPath = getReadPath(jsonToolCall.args)
                            if (readPath) fileRegistry.set(normPath(readPath), { content: result.content, step })
                        }
                    }

                    const jsonSummary = summarizeForUI(jsonToolCall.tool, jsonToolCall.args, result)
                    agent.bus.emitEvent('agent:tool-result', {
                        agentType: agent.type,
                        taskId: context.taskId,
                        tool: jsonToolCall.tool,
                        success: result.success,
                        summary: jsonSummary,
                        step,
                    })
                    emitToolCallInfo(agent.bus, agent.type, {
                        taskId: context.taskId, step, tool: jsonToolCall.tool,
                        args: jsonToolCall.args, success: result.success, summary: jsonSummary,
                        duration: jsonDuration,
                        resultPreview: result.content.slice(0, 300),
                    })
                    continue
                }
            }

            const proseExtraction = extractToolsFromProse(response.content)
            if (proseExtraction.toolCalls.length > 0) {
                console.log(`[${agent.type}] Step ${step}: Prose extraction found ${proseExtraction.toolCalls.length} synthetic tool call(s)`)
                let proseToolSuccess = false
                const proseResults: string[] = []

                for (const syntheticCall of proseExtraction.toolCalls) {
                    const toolBaseName = syntheticCall.tool.split('::').pop() ?? syntheticCall.tool
                    const perm = canAgentCallTool(agent.type, syntheticCall.tool)
                    if (!perm.allowed) {
                        console.log(`[${agent.type}] Prose tool ${syntheticCall.tool} blocked: ${perm.reason}`)
                        proseResults.push(`${toolBaseName}: PERMISSION DENIED — ${perm.reason}`)
                        continue
                    }

                    // Check .brainwaveignore for file operations
                    if (ignoreMatcher.hasPatterns && syntheticCall.args.path) {
                        const tp = String(syntheticCall.args.path)
                        if (ignoreMatcher.isIgnored(tp)) {
                            proseResults.push(`${toolBaseName}: ACCESS BLOCKED by .brainwaveignore`)
                            continue
                        }
                    }

                    try {
                        const proseStartTime = Date.now()
                        const result = syntheticCall.tool.startsWith('local::')
                            ? await localProvider.callTool(toolBaseName, syntheticCall.args)
                            : await registry.callTool(syntheticCall.tool, syntheticCall.args)
                        const proseDuration = Date.now() - proseStartTime

                        toolResults.push({ tool: syntheticCall.tool, success: result.success, content: result.content })
                        proseResults.push(`${toolBaseName} → ${result.success ? 'OK' : 'FAIL'}: ${result.content.slice(0, 150)}`)
                        if (result.success) proseToolSuccess = true

                        // Update file registry for read ops
                        if (result.success) {
                            const isReadOp = ['file_read', 'directory_list', 'read_file'].includes(toolBaseName)
                            if (isReadOp) {
                                const readPath = getReadPath(syntheticCall.args)
                                if (readPath) fileRegistry.set(normPath(readPath), { content: result.content, step })
                            }
                        }

                        const proseSummary = summarizeForUI(syntheticCall.tool, syntheticCall.args, result)
                        agent.bus.emitEvent('agent:tool-result', {
                            agentType: agent.type,
                            taskId: context.taskId,
                            tool: syntheticCall.tool,
                            success: result.success,
                            summary: proseSummary,
                            step,
                        })
                        emitToolCallInfo(agent.bus, agent.type, {
                            taskId: context.taskId, step, tool: syntheticCall.tool,
                            args: syntheticCall.args as Record<string, string>,
                            success: result.success, summary: proseSummary,
                            duration: proseDuration,
                            resultPreview: result.content.slice(0, 300),
                        })
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err)
                        proseResults.push(`${toolBaseName} → ERROR: ${errMsg.slice(0, 150)}`)
                        toolResults.push({ tool: syntheticCall.tool, success: false, content: errMsg })
                    }
                }

                // Feed results back to the model so it knows what happened
                const proseToolSummary = proseResults.join('\n')
                conversation.addToolResult(
                    'prose-extraction',
                    proseToolSuccess,
                    `[Prose Extraction] Detected and executed ${proseExtraction.toolCalls.length} tool call(s) from your markdown output:\n${proseToolSummary}\n\n` +
                    `Tip: For better reliability, use XML tool blocks directly. Example:\n` +
                    `<write_to_file>\n<path>src/file.ts</path>\n<content>file content here</content>\n</write_to_file>`
                )

                // Reset no-tool-use counter since the model IS producing actionable output
                mistakes.noToolUse = 0

                // If the prose also had a completion signal, wrap up
                if (proseExtraction.completionResult && proseToolSuccess) {
                    console.log(`[${agent.type}] Prose extraction includes completion signal — finishing`)
                    return buildToolResult(
                        'success',
                        proseExtraction.completionResult,
                        0.8,
                        totalTokensIn, totalTokensOut, model, startTime, artifacts
                    )
                }

                continue
            }

            // If prose extraction found a completion signal but no tool calls,
            // treat it as an attempt_completion
            if (proseExtraction.completionResult) {
                console.log(`[${agent.type}] Prose extraction found completion signal at step ${step}`)
                const anySuccess = toolResults.some(t => t.success)
                return buildToolResult(
                    anySuccess ? 'success' : 'partial',
                    proseExtraction.completionResult,
                    anySuccess ? 0.8 : 0.6,
                    totalTokensIn, totalTokensOut, model, startTime, artifacts
                )
            }

            // ── No Tool Use - Grace/Abort ──
            if (step < ABSOLUTE_MAX_STEPS - 1) {
                mistakes.noToolUse++
                if (mistakes.noToolUse >= 8) break // abort
                conversation.addMessage('user', "No tool call detected. Please use <tool>...</tool> or <attempt_completion>.")
                continue
            }

            // Last step falls through to partial result
            const anySuccess = toolResults.some(t => t.success)
            return buildToolResult(
                anySuccess ? 'success' : 'partial',
                response.content,
                anySuccess ? 0.7 : 0.5,
                totalTokensIn, totalTokensOut, model, startTime, artifacts
            )
        } // end while

        // ── Loop/Safety Exit ──
        return buildToolResult(
            'failed',
            loopDetected ? 'Loop detected.' : 'Safety limit reached.',
            0.3,
            totalTokensIn, totalTokensOut, model, startTime, artifacts
        )

    } catch (err) {
        if (CancellationError.is(err)) {
            return buildToolResult('failed', 'Cancelled', 0, 0, 0, model, startTime, artifacts)
        }
        return buildToolResult('failed', String(err), 0, 0, 0, model, startTime, artifacts, String(err))
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildToolResult(
    status: 'success' | 'partial' | 'failed',
    output: unknown,
    confidence: number,
    tokensIn: number,
    tokensOut: number,
    model: string,
    startTime: number,
    artifacts: Artifact[],
    error?: string,
    cost?: number,
): AgentResult {
    return {
        status,
        output,
        confidence,
        tokensIn,
        tokensOut,
        model,
        artifacts: artifacts.length > 0 ? artifacts : undefined,
        error,
        duration: Date.now() - startTime,
        cost,
    }
}

/** 
 * Local streaming implementation to decouple from BaseAgent
 */
async function streamWithHistory(
    agent: BaseAgentHandle,
    messages: ConversationMessage[],
    context: AgentContext,
    overrides?: { temperature?: number; maxTokens?: number },
    instructionBlock?: string
): Promise<LLMResponse> {
    const adapter = LLMFactory.getForAgent(agent.type)
    const modelConfig = LLMFactory.getAgentConfig(agent.type)
    const systemPrompt = await agent.getSystemPrompt(context)
    const softRules = getSoftEngine().buildConstraintBlock(agent.type)

    const request: LLMRequest = {
        model: modelConfig?.model,
        system: systemPrompt + (instructionBlock ?? '') + softRules,
        user: '',
        messages,
        temperature: overrides?.temperature ?? modelConfig?.temperature ?? 0.7,
        maxTokens: overrides?.maxTokens ?? modelConfig?.maxTokens,
        signal: context.cancellationToken?.signal,
    }

    let accumulated = ''
    let isFirst = true

    try {
        for await (const chunk of adapter.stream(request)) {
            accumulated += chunk
            agent.bus.emitEvent('agent:stream-chunk', {
                taskId: context.taskId,
                agentType: agent.type,
                chunk,
                isFirst,
            })
            isFirst = false
        }
    } catch (err) {
        // Simple retry logic could go here
        if (!accumulated) throw err
        console.warn(`[${agent.type}] Stream error:`, err)
    }

    agent.bus.emitEvent('agent:stream-end', {
        taskId: context.taskId,
        agentType: agent.type,
        fullText: accumulated,
    })

    const systemTokens = countTokens(request.system + (request.context ?? ''))
    const messagesTokens = messages.reduce((sum, m) => sum + countTokens(m.content), 0)
    const outputTokens = countTokens(accumulated)

    return {
        content: accumulated,
        model: request.model ?? 'unknown',
        tokensIn: systemTokens + messagesTokens,
        tokensOut: outputTokens,
        finishReason: 'stop',
    }
}
