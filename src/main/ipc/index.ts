import { randomUUID } from 'node:crypto'
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ipcMain, app, dialog, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '@shared/types'
import type { TaskSubmission, MemoryQuery, CreateScheduledJobInput } from '@shared/types'
import { getScheduler } from '../services/scheduler.service'
import { getDatabase } from '../db/database'
import { LLMFactory, getAllCircuitBreakerStatus } from '../llm'
import { MODEL_MODE_PRESETS } from '../llm/types'
import { OllamaProvider } from '../llm/ollama'
import { getMcpRegistry } from '../mcp'
import type { McpServerConfig } from '../mcp'
import { getPluginRegistry } from '../plugins'
import { fetchDailyPulseSection } from '../services/daily-pulse'
import { getOrchestrator } from '../agents/orchestrator'
import { getAgentPool } from '../agents/agent-pool'
import { getEventBus } from '../agents/event-bus'
import { getMemoryManager, exportAllMemories, importAllMemories } from '../memory'
import { getPeopleStore } from '../memory/people'
import { getCalibrationTracker } from '../agents/calibration'
import { getCheckpointService } from '../agents/checkpoint-service'
import { getModeRegistry } from '../modes'
import { getInstructionManager } from '../instructions'
import { extractDocumentText } from '../tools/document-extractor'
import { getPromptRegistry } from '../prompts'
import { getProceduralStore } from '../memory/procedural'
import { getProspectiveStore } from '../memory/prospective'
import { getHardEngine, getSoftEngine } from '../rules'
import type { SafetyRules, BehaviorRules } from '../rules'
import type { McpRegistry } from '../mcp/registry'
import OpenAI from 'openai'

// ─── MCP JSON Import Parser ────────────────────────────────

/** Strip line and block comments from JSONC without touching strings */
function stripJsoncComments(input: string): string {
  let result = ''
  let i = 0
  while (i < input.length) {
    // String literal — copy verbatim including escapes
    if (input[i] === '"') {
      result += '"'
      i++
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          result += input[i] + input[i + 1]
          i += 2
        } else {
          result += input[i]
          i++
        }
      }
      if (i < input.length) { result += '"'; i++ }
    }
    // Line comment
    else if (input[i] === '/' && i + 1 < input.length && input[i + 1] === '/') {
      i += 2
      while (i < input.length && input[i] !== '\n') i++
    }
    // Block comment
    else if (input[i] === '/' && i + 1 < input.length && input[i + 1] === '*') {
      i += 2
      while (i < input.length && !(input[i] === '*' && i + 1 < input.length && input[i + 1] === '/')) i++
      if (i < input.length) i += 2
    }
    // Normal character
    else {
      result += input[i]
      i++
    }
  }
  return result
}

/**
 * Parse a VS Code / generic MCP JSON config and import all servers.
 *
 * Supported formats:
 *   { "servers": { "name": { type, command, args, url, ... } } }  (VS Code style)
 *   { "mcpServers": { ... } }                                     (alternative key)
 *   { "name": { type, command, args, url, ... } }                 (bare object)
 *
 * Transport mapping:  "stdio" → "stdio",  "http" | "sse" → "sse"
 * Environment vars:   extracted from `-e KEY=VAL` in args (Docker pattern)
 *                     OR from an explicit "env" object
 */
function importMcpServersFromJson(
  json: string,
  registry: McpRegistry
): { imported: number; skipped: number; errors: string[] } {
  const errors: string[] = []
  let imported = 0
  let skipped = 0

  let raw: Record<string, unknown>
  try {
    // Strip JSONC comments while preserving strings (// and /* */ inside quotes are kept)
    const cleaned = stripJsoncComments(json)
      // Remove trailing commas before } or ]
      .replace(/,\s*([\]}])/g, '$1')
    raw = JSON.parse(cleaned)
  } catch (err) {
    return { imported: 0, skipped: 0, errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }

  // Detect the servers object
  const serversObj = (
    (raw.servers as Record<string, unknown>) ??
    (raw.mcpServers as Record<string, unknown>) ??
    // If the object itself looks like a servers map (keys have type/command/url props)
    (Object.values(raw).some((v) => v && typeof v === 'object' && ('type' in (v as object) || 'command' in (v as object)))
      ? raw
      : null)
  )

  if (!serversObj || typeof serversObj !== 'object') {
    return { imported: 0, skipped: 0, errors: ['Could not find "servers" or "mcpServers" key in the JSON.'] }
  }

  // Get existing configs to skip duplicates
  const existingConfigs = registry.getConfigs()
  const existingNames = new Set(existingConfigs.map((c) => c.name.toLowerCase()))

  for (const [name, value] of Object.entries(serversObj)) {
    try {
      if (!value || typeof value !== 'object') {
        errors.push(`"${name}": Not a valid server object`)
        continue
      }

      const srv = value as Record<string, unknown>

      // Skip duplicates by name
      if (existingNames.has(name.toLowerCase())) {
        skipped++
        errors.push(`"${name}": Skipped — already exists`)
        continue
      }

      // Determine transport
      const rawType = String(srv.type ?? 'stdio').toLowerCase()
      const transport: 'stdio' | 'sse' = (rawType === 'http' || rawType === 'sse') ? 'sse' : 'stdio'

      // Extract env vars from explicit env object only
      let env: Record<string, string> = {}
      if (srv.env && typeof srv.env === 'object') {
        env = { ...(srv.env as Record<string, string>) }
      }

      // Parse args — keep them exactly as provided (Docker -e flags stay in args)
      let args: string[] = []
      if (Array.isArray(srv.args)) {
        args = srv.args.map(String)
      }

      if (transport === 'stdio') {
        const command = srv.command ? String(srv.command) : undefined
        if (!command) {
          errors.push(`"${name}": Missing "command" for stdio transport`)
          continue
        }

        registry.addServer({
          name,
          transport: 'stdio',
          command,
          args: args.length > 0 ? args : undefined,
          env: Object.keys(env).length > 0 ? env : undefined,
          autoConnect: true,
          enabled: true,
        })
      } else {
        const url = srv.url ? String(srv.url) : undefined
        if (!url) {
          errors.push(`"${name}": Missing "url" for http/sse transport`)
          continue
        }

        registry.addServer({
          name,
          transport: 'sse',
          url,
          env: Object.keys(env).length > 0 ? env : undefined,
          autoConnect: true,
          enabled: true,
        })
      }

      existingNames.add(name.toLowerCase())
      imported++
    } catch (err) {
      errors.push(`"${name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { imported, skipped, errors }
}

/**
 * Apply saved model overrides from DB for the given mode.
 * Called after setMode() and on app startup.
 */
export function applyModelOverrides(db: ReturnType<typeof getDatabase>, mode: string): void {
  const dbKey = `model_overrides_${mode}`
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(dbKey) as { value: string } | undefined
  if (!row) return

  try {
    const overrides: Record<string, string> = JSON.parse(row.value)
    for (const [agent, modelId] of Object.entries(overrides)) {
      if (modelId) {
        LLMFactory.setAgentModel(agent, { provider: 'openrouter', model: modelId })
        console.log(`[Model Override] Restored ${agent} → ${modelId}`)
      }
    }
  } catch (err) {
    console.error('[Model Override] Failed to parse overrides:', err)
  }
}

export function registerIpcHandlers(): void {
  // ─── Window Controls ───
  ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on(IPC_CHANNELS.WINDOW_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      win.isMaximized() ? win.unmaximize() : win.maximize()
    }
  })

  ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  // ─── App Info ───
  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, () => {
    return app.getVersion()
  })

  // ─── Agent System ───
  const orchestrator = getOrchestrator()
  const agentPool = getAgentPool()
  const eventBus = getEventBus()

  // Wire the agent pool as the executor for the orchestrator
  orchestrator.setExecutor((subTask, context) => agentPool.executeTask(subTask, context))

  // ─── Document Text Extraction ───
  ipcMain.handle(IPC_CHANNELS.DOCUMENT_EXTRACT_TEXT, async (_event, filePath: string) => {
    try {
      const text = await extractDocumentText(filePath)
      const { statSync } = await import('node:fs')
      const sizeBytes = statSync(filePath).size
      return { text, sizeBytes }
    } catch (err) {
      console.error('[IPC] Document extraction failed:', err)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SUBMIT_TASK, async (_event, task: TaskSubmission) => {
    const record = await orchestrator.submitTask(task.prompt, task.priority ?? 'normal', task.sessionId, task.images, task.mode, task.documents)
    return { taskId: record.id }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_CANCEL_TASK, async (_event, taskId: string) => {
    orchestrator.cancelTask(taskId)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_STATUS, async () => {
    const pool = agentPool.getStatus()
    // Return status for each registered agent type + orchestrator
    const agentTypes = ['orchestrator' as const, ...pool.agents]
    return agentTypes.map((type) => {
      const realState = agentPool.getAgentState(type)
      return {
        id: type,
        type,
        state: realState.state,
        currentTaskId: realState.taskId,
        model: LLMFactory.getAgentConfig(type)?.model,
      }
    })
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_TASKS, async () => {
    return orchestrator.getActiveTasks()
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_TASK_HISTORY, async (_event, limit?: number) => {
    return orchestrator.getTaskHistory(limit)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_LOG_HISTORY, async (_event, limit?: number) => {
    const db = getDatabase()
    const rows = db.all(
      `SELECT id, agent_type, task_id, status, llm_model, tokens_in, tokens_out, confidence, started_at, completed_at, error
       FROM agent_runs ORDER BY started_at DESC LIMIT ?`,
      limit ?? 100
    ) as Array<{
      id: string
      agent_type: string
      task_id: string | null
      status: string
      llm_model: string | null
      tokens_in: number
      tokens_out: number
      confidence: number | null
      started_at: string
      completed_at: string | null
      error: string | null
    }>

    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id ?? '',
      agentId: row.agent_type,
      agentType: row.agent_type,
      level: row.status === 'failed' ? 'error' as const : 'info' as const,
      message: row.status === 'completed'
        ? `Completed (confidence: ${row.confidence !== null ? (row.confidence * 100).toFixed(0) + '%' : 'n/a'}, model: ${row.llm_model ?? 'unknown'}, tokens: ${row.tokens_in + row.tokens_out})`
        : row.status === 'failed'
          ? `Failed: ${row.error ?? 'unknown error'}`
          : `${row.status} (model: ${row.llm_model ?? 'unknown'})`,
      timestamp: new Date(row.started_at).getTime(),
    }))
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_CLEAR_LOG_HISTORY, async () => {
    const db = getDatabase()
    db.run('DELETE FROM agent_runs')
    console.log('[AgentMonitor] Cleared all agent run history')
  })

  // Forward agent events to renderer
  const forwardToRenderer = (channel: string, data: unknown) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(channel, data)
    })
  }

  // ─── Task Live State Accumulator ───
  // Keeps currentStep + activityLog in main process memory so the renderer
  // can replay them when the user navigates away and back.
  const taskLiveState = new Map<string, { currentStep?: string; activityLog: string[]; progress?: number; status: string }>()

  function updateLiveState(taskId: string, update: { currentStep?: string; progress?: number; status: string }) {
    let state = taskLiveState.get(taskId)
    if (!state) {
      state = { activityLog: [], status: update.status }
      taskLiveState.set(taskId, state)
    }
    state.status = update.status
    if (update.progress !== undefined) state.progress = update.progress
    if (update.currentStep && update.currentStep !== state.currentStep) {
      state.activityLog.push(update.currentStep)
      state.currentStep = update.currentStep
    }
    // Clean up completed/failed/cancelled tasks after 5 min to avoid memory leak
    if (update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled') {
      setTimeout(() => taskLiveState.delete(taskId), 5 * 60 * 1000)
    }
  }

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_TASK_LIVE_STATE, async (_event, taskIds: string[]) => {
    const result: Record<string, { currentStep?: string; activityLog: string[]; progress?: number; status: string }> = {}
    for (const id of taskIds) {
      const state = taskLiveState.get(id)
      if (state) result[id] = { ...state, activityLog: [...state.activityLog] }
    }
    return result
  })

  // Task lifecycle events → renderer
  eventBus.onEvent('task:submitted', (data) => {
    updateLiveState(data.taskId, { status: 'queued' })
    forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
      taskId: data.taskId, status: 'queued', timestamp: Date.now(),
    })
  })
  eventBus.onEvent('task:planning', (data) => {
    updateLiveState(data.taskId, { status: 'planning', currentStep: 'Analyzing task...' })
    forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
      taskId: data.taskId, status: 'planning', currentStep: 'Analyzing task...', timestamp: Date.now(),
    })
  })
  eventBus.onEvent('plan:created', (data) => {
    const agentList = data.agents.join(', ')
    const step = `Planning: ${data.steps} step${data.steps > 1 ? 's' : ''} → ${agentList}`
    updateLiveState(data.taskId, { status: 'executing', currentStep: step })
    forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
      taskId: data.taskId, status: 'executing', currentStep: step, timestamp: Date.now(),
    })
  })
  eventBus.onEvent('plan:task-list', (data) => {
    // Forward the full task list to the renderer for progress tracking
    forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
      taskId: data.taskId, status: 'executing', timestamp: Date.now(),
      taskList: data.items.map(item => ({
        id: item.id,
        title: item.title,
        agent: item.agent,
        status: item.status,
        dependsOn: item.dependsOn,
      })),
    })
  })
  eventBus.onEvent('plan:task-item-update', (data) => {
    // Forward individual task item status updates to the renderer
    forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
      taskId: data.taskId, status: 'executing', timestamp: Date.now(),
      taskListUpdate: { itemId: data.itemId, status: data.status },
    })
  })
  eventBus.onEvent('task:progress', (data) => {
    updateLiveState(data.taskId, { status: 'executing', progress: data.progress, currentStep: data.currentStep })
    forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
      taskId: data.taskId, status: 'executing', progress: data.progress, currentStep: data.currentStep, timestamp: Date.now(),
    })
  })
  eventBus.onEvent('plan:step-completed', (data) => {
    const step = `✓ ${data.agentType} completed`
    updateLiveState(data.taskId, { status: 'executing', currentStep: step })
    forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
      taskId: data.taskId, status: 'executing', currentStep: step, timestamp: Date.now(),
    })
  })
  eventBus.onEvent('task:completed', (data) => {
    updateLiveState(data.taskId, { status: 'completed' })
    forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
      taskId: data.taskId, status: 'completed', result: data.result, timestamp: Date.now(),
    })
  })
  eventBus.onEvent('task:failed', (data) => {
    updateLiveState(data.taskId, { status: 'failed' })
    forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
      taskId: data.taskId, status: 'failed', error: data.error, timestamp: Date.now(),
    })
  })
  eventBus.onEvent('task:cancelled', (data) => {
    updateLiveState(data.taskId, { status: 'cancelled' })
    forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
      taskId: data.taskId, status: 'cancelled', timestamp: Date.now(),
    })
  })

  // Agent activity events → renderer log
  eventBus.onEvent('agent:thinking', (data) => forwardToRenderer(IPC_CHANNELS.AGENT_LOG, {
    id: `log_${Date.now()}`, taskId: data.taskId, agentId: data.agentType, agentType: data.agentType,
    level: 'info', message: `Thinking with ${data.model}...`, timestamp: Date.now(),
  }))
  eventBus.onEvent('agent:acting', (data) => {
    forwardToRenderer(IPC_CHANNELS.AGENT_LOG, {
      id: `log_${Date.now()}`, taskId: data.taskId, agentId: data.agentType, agentType: data.agentType,
      level: 'info', message: data.action, timestamp: Date.now(),
    })
    // Forward reasoning steps (prefixed with 💭) to the activity log in CommandCenter
    if (data.action.startsWith('💭')) {
      const reasoning = data.action.slice(2).trim()
      const step = `💭 ${reasoning}`
      updateLiveState(data.taskId, { status: 'executing', currentStep: step })
      forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
        taskId: data.taskId, status: 'executing', currentStep: step, timestamp: Date.now(),
      })
    }
  })
  eventBus.onEvent('agent:completed', (data) => forwardToRenderer(IPC_CHANNELS.AGENT_LOG, {
    id: `log_${Date.now()}`, taskId: data.taskId, agentId: data.agentType, agentType: data.agentType,
    level: 'info', message: `Completed (confidence: ${(data.confidence * 100).toFixed(0)}%, tokens: ${data.tokensIn + data.tokensOut})`, timestamp: Date.now(),
  }))
  eventBus.onEvent('agent:error', (data) => forwardToRenderer(IPC_CHANNELS.AGENT_LOG, {
    id: `log_${Date.now()}`, taskId: data.taskId, agentId: data.agentType, agentType: data.agentType,
    level: 'error', message: data.error, timestamp: Date.now(),
  }))

  // Live tool-result streaming → renderer (appears in activity log as results arrive)
  eventBus.onEvent('agent:tool-result', (data) => {
    const icon = data.success ? '✓' : '✗'
    const step = `${icon} ${data.summary}`
    updateLiveState(data.taskId, { status: 'executing', currentStep: step })
    forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
      taskId: data.taskId, status: 'executing', currentStep: step, timestamp: Date.now(),
    })
  })

  // Structured tool-call-info → renderer (rich tool cards with args, duration, preview)
  eventBus.onEvent('agent:tool-call-info', (data) => {
    forwardToRenderer(IPC_CHANNELS.AGENT_TOOL_CALL_INFO, {
      taskId: data.taskId,
      agentType: data.agentType,
      step: data.step,
      tool: data.tool,
      toolName: data.toolName,
      args: data.args,
      success: data.success,
      summary: data.summary,
      duration: data.duration,
      resultPreview: data.resultPreview,
      timestamp: Date.now(),
    })
  })

  // Context usage → renderer (context window indicator bar)
  eventBus.onEvent('agent:context-usage', (data) => {
    forwardToRenderer(IPC_CHANNELS.AGENT_CONTEXT_USAGE, {
      taskId: data.taskId,
      agentType: data.agentType,
      tokensUsed: data.tokensUsed,
      budgetTotal: data.budgetTotal,
      usagePercent: data.usagePercent,
      messageCount: data.messageCount,
      condensations: data.condensations,
      step: data.step,
    })
  })

  // Escalation events — agent retries exhausted
  eventBus.onEvent('task:escalation', (data) => forwardToRenderer(IPC_CHANNELS.AGENT_LOG, {
    id: `log_${Date.now()}`, taskId: data.taskId, agentId: data.agent, agentType: data.agent,
    level: 'error', message: `⚠ ESCALATION: ${data.message}`, timestamp: Date.now(),
  }))
  eventBus.onEvent('task:escalation', (data) => {
    const step = `⚠ ${data.agent} failed after ${data.attempts} attempts — continuing with remaining steps`
    updateLiveState(data.taskId, { status: 'executing', currentStep: step })
    forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
      taskId: data.taskId, status: 'executing', currentStep: step, timestamp: Date.now(),
    })
  })

  // Streaming events — forward LLM response chunks to renderer for live text display
  eventBus.onEvent('agent:stream-chunk', (data) => {
    forwardToRenderer(IPC_CHANNELS.AGENT_STREAM_CHUNK, {
      taskId: data.taskId,
      agentType: data.agentType,
      chunk: data.chunk,
      isFirst: data.isFirst,
      isDone: false,
    })
  })
  eventBus.onEvent('agent:stream-end', (data) => {
    forwardToRenderer(IPC_CHANNELS.AGENT_STREAM_CHUNK, {
      taskId: data.taskId,
      agentType: data.agentType,
      chunk: '',
      isFirst: false,
      isDone: true,
      fullText: data.fullText,
    })
  })

  // Agent follow-up questions — forward to renderer, listen for responses
  eventBus.onEvent('agent:ask-user', (data) => {
    forwardToRenderer(IPC_CHANNELS.AGENT_ASK_USER, {
      questionId: data.questionId,
      question: data.question,
      options: data.options,
    })
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_USER_RESPONSE, (_event, questionId: string, response: string) => {
    eventBus.emitEvent('agent:user-response', { questionId, response })
  })

  // Agent tool approval — forward to renderer, listen for responses
  eventBus.onEvent('agent:approval-needed', (data) => {
    forwardToRenderer(IPC_CHANNELS.AGENT_APPROVAL_NEEDED, {
      approvalId: data.approvalId,
      taskId: data.taskId,
      agentType: data.agentType,
      tool: data.tool,
      args: data.args,
      summary: data.summary,
      diffPreview: data.diffPreview,
      safetyLevel: data.safetyLevel,
    })
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_APPROVAL_RESPONSE, (_event, approvalId: string, approved: boolean, feedback?: string, reason?: string) => {
    eventBus.emitEvent('agent:approval-response', { approvalId, approved, feedback, reason })
  })

  // ─── Checkpoints ───
  const checkpointService = getCheckpointService()

  eventBus.onEvent('agent:checkpoint', (data) => {
    forwardToRenderer(IPC_CHANNELS.AGENT_CHECKPOINT_CREATED, data)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_CHECKPOINTS, async (_event, taskId: string) => {
    return checkpointService.getCheckpoints(taskId)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_ROLLBACK_CHECKPOINT, async (_event, taskId: string, checkpointId: string) => {
    const result = await checkpointService.rollbackToCheckpoint(process.cwd(), taskId, checkpointId)
    eventBus.emitEvent('agent:rollback', {
      taskId,
      checkpointId,
      commitHash: result.commitHash,
      rolledBackToStep: result.step,
    })
    return result
  })

  // ─── Memory (wired to MemoryManager) ───
  const memoryManager = getMemoryManager()

  ipcMain.handle(IPC_CHANNELS.MEMORY_QUERY, async (_event, query: MemoryQuery) => {
    const results = await memoryManager.recall(query.query, {
      memoryTypes: query.type && query.type !== 'people' && query.type !== 'procedural'
        ? [query.type as 'episodic' | 'semantic']
        : ['episodic', 'semantic'],
      limit: query.limit ?? 20,
    })

    // Map RecallResults to the MemoryEntry shape the renderer expects
    return results.map((r) => ({
      id: r.id,
      type: r.type,
      content: r.content,
      importance: r.relevance,
      createdAt: 'createdAt' in r.entry ? (r.entry as Record<string, unknown>).createdAt : new Date().toISOString(),
      lastAccessed: 'lastAccessed' in r.entry ? (r.entry as Record<string, unknown>).lastAccessed : new Date().toISOString(),
      accessCount: 'accessCount' in r.entry ? (r.entry as Record<string, unknown>).accessCount : 0,
      tags: 'tags' in r.entry ? (r.entry as Record<string, unknown>).tags : [],
    }))
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_DELETE, async (_event, id: string, type: string) => {
    return memoryManager.deleteMemory(id, type as 'episodic' | 'semantic')
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_STATS, async () => {
    const people = getPeopleStore()
    const procedural = getProceduralStore()
    const prospective = getProspectiveStore()
    return {
      episodic: memoryManager.episodic.count(),
      semantic: memoryManager.semantic.count(),
      procedural: procedural.count(),
      prospective: prospective.count(),
      people: people.count(),
    }
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_RECENT, async (_event, limit?: number) => {
    const recent = memoryManager.episodic.getRecent(limit ?? 20)
    return recent.map((e) => ({
      id: e.id,
      type: 'episodic' as const,
      content: e.content,
      importance: e.importance,
      createdAt: e.timestamp,
      lastAccessed: e.lastAccessed,
      accessCount: e.accessCount,
      tags: e.tags,
    }))
  })

  // ─── Memory Export/Import ───
  ipcMain.handle(IPC_CHANNELS.MEMORY_EXPORT, async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showSaveDialog(win!, {
      title: 'Export Brainwave Memories',
      defaultPath: `brainwave-memories-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Cancelled' }
    }

    try {
      const exportData = exportAllMemories()
      const totalCount = Object.values(exportData.data).reduce((sum, arr) => sum + arr.length, 0)
      writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8')
      return { success: true, filePath: result.filePath, count: totalCount }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_IMPORT, async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Import Brainwave Memories',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'Cancelled' }
    }

    try {
      const raw = readFileSync(result.filePaths[0], 'utf-8')
      const exportData = JSON.parse(raw)

      if (!exportData.version || !exportData.data) {
        return { success: false, error: 'Invalid export file format' }
      }

      const { imported, skipped } = importAllMemories(exportData)
      return { success: true, imported, skipped }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ─── People ───
  const peopleStore = getPeopleStore()

  ipcMain.handle(IPC_CHANNELS.PEOPLE_GET_ALL, async () => {
    return peopleStore.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.PEOPLE_GET_BY_ID, async (_event, id: string) => {
    return peopleStore.getById(id)
  })

  ipcMain.handle(IPC_CHANNELS.PEOPLE_SEARCH, async (_event, query: string) => {
    return peopleStore.search(query)
  })

  ipcMain.handle(IPC_CHANNELS.PEOPLE_CREATE, async (_event, input: { name: string; relationship?: string; traits?: string[] }) => {
    return peopleStore.store(input)
  })

  ipcMain.handle(IPC_CHANNELS.PEOPLE_UPDATE, async (_event, id: string, input: { name?: string; relationship?: string; traits?: string[] }) => {
    return peopleStore.update(id, input)
  })

  ipcMain.handle(IPC_CHANNELS.PEOPLE_DELETE, async (_event, id: string) => {
    return peopleStore.delete(id)
  })

  ipcMain.handle(IPC_CHANNELS.PEOPLE_ADD_INTERACTION, async (_event, id: string, interaction: { date: string; type: string; summary: string }) => {
    return peopleStore.addInteraction(id, interaction)
  })

  // ─── Procedural Memory ───
  const proceduralStore = getProceduralStore()

  ipcMain.handle(IPC_CHANNELS.PROCEDURAL_GET_ALL, async () => {
    return proceduralStore.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.PROCEDURAL_GET_BY_ID, async (_event, id: string) => {
    return proceduralStore.getById(id)
  })

  ipcMain.handle(IPC_CHANNELS.PROCEDURAL_SEARCH, async (_event, query: string) => {
    return proceduralStore.search(query)
  })

  ipcMain.handle(IPC_CHANNELS.PROCEDURAL_CREATE, async (_event, input: { name: string; description?: string; steps: Array<{ order: number; action: string }>; tags?: string[] }) => {
    return proceduralStore.store(input)
  })

  ipcMain.handle(IPC_CHANNELS.PROCEDURAL_DELETE, async (_event, id: string) => {
    return proceduralStore.delete(id)
  })

  // ─── Prospective Memory ───
  const prospectiveStore = getProspectiveStore()

  ipcMain.handle(IPC_CHANNELS.PROSPECTIVE_GET_ALL, async () => {
    return prospectiveStore.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.PROSPECTIVE_GET_PENDING, async () => {
    return prospectiveStore.getPending()
  })

  ipcMain.handle(IPC_CHANNELS.PROSPECTIVE_CREATE, async (_event, input: { intention: string; triggerType: 'time' | 'event' | 'condition'; triggerValue: string; priority?: number; dueAt?: string; tags?: string[] }) => {
    return prospectiveStore.store(input)
  })

  ipcMain.handle(IPC_CHANNELS.PROSPECTIVE_COMPLETE, async (_event, id: string) => {
    prospectiveStore.markCompleted(id)
  })

  ipcMain.handle(IPC_CHANNELS.PROSPECTIVE_DELETE, async (_event, id: string) => {
    return prospectiveStore.delete(id)
  })

  // ─── Rules Engine ───
  const hardEngine = getHardEngine()
  const softEngine = getSoftEngine()

  ipcMain.handle(IPC_CHANNELS.RULES_GET_SAFETY, async () => {
    return hardEngine.getRules()
  })

  ipcMain.handle(IPC_CHANNELS.RULES_SET_SAFETY, async (_event, rules: SafetyRules) => {
    hardEngine.updateRules(rules)
  })

  ipcMain.handle(IPC_CHANNELS.RULES_GET_BEHAVIOR, async () => {
    return softEngine.getRules()
  })

  ipcMain.handle(IPC_CHANNELS.RULES_SET_BEHAVIOR, async (_event, rules: BehaviorRules) => {
    softEngine.updateRules(rules)
  })

  ipcMain.handle(IPC_CHANNELS.RULES_GET_PROPOSALS, async () => {
    return softEngine.getPendingProposals()
  })

  ipcMain.handle(IPC_CHANNELS.RULES_ACCEPT_PROPOSAL, async (_event, id: string) => {
    return softEngine.acceptProposal(id)
  })

  ipcMain.handle(IPC_CHANNELS.RULES_DISMISS_PROPOSAL, async (_event, id: string) => {
    return softEngine.dismissProposal(id)
  })

  ipcMain.handle(IPC_CHANNELS.RULES_RELOAD, async () => {
    hardEngine.reload()
    softEngine.reload()
  })

  // ─── Settings (DB-backed) ───
  const db = getDatabase()

  // Directory picker dialog
  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY, async (_event, title?: string) => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: title || 'Select Directory',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (_event, key: string) => {
    const row = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key)
    return row ? JSON.parse(row.value) : null
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event, key: string, value: unknown) => {
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      key,
      JSON.stringify(value)
    )

    // If an API key was updated, reconfigure the LLM factory
    if (key === 'openrouter_api_key' && typeof value === 'string') {
      LLMFactory.configure('openrouter', { apiKey: value })
    } else if (key === 'replicate_api_key' && typeof value === 'string') {
      LLMFactory.configure('replicate', { apiKey: value })
    } else if (key === 'ollama_host' && typeof value === 'string') {
      // Re-configure Ollama with the new host URL
      const modelRow = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'ollama_default_model')
      const defaultModel = modelRow?.value ? JSON.parse(modelRow.value) : undefined
      LLMFactory.configure('ollama', { apiKey: value, defaultModel })
    } else if (key === 'ollama_default_model' && typeof value === 'string') {
      // Re-configure Ollama with the new default model
      const hostRow = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'ollama_host')
      const host = hostRow?.value ? JSON.parse(hostRow.value) : 'http://localhost:11434'
      LLMFactory.configure('ollama', { apiKey: host, defaultModel: value })
    }
  })

  // ─── Speech-to-Text (Whisper) ───
  ipcMain.handle(
    IPC_CHANNELS.STT_TRANSCRIBE,
    async (_event, audioBuffer: ArrayBuffer, mimeType: string) => {
      try {
        // Read STT settings from DB
        const keyRow = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'stt_api_key')
        const providerRow = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'stt_provider')

        const sttKey = keyRow ? JSON.parse(keyRow.value) : ''
        const sttProvider: string = providerRow ? JSON.parse(providerRow.value) : 'groq'

        if (!sttKey) {
          return { error: 'No speech-to-text API key configured. Go to Settings → Models to add one.' }
        }

        // Determine API base URL & model based on provider
        let baseURL: string
        let model: string
        if (sttProvider === 'openai') {
          baseURL = 'https://api.openai.com/v1'
          model = 'whisper-1'
        } else {
          // Default: Groq (free, fast)
          baseURL = 'https://api.groq.com/openai/v1'
          model = 'whisper-large-v3-turbo'
        }

        // Write audio buffer to a temp file (OpenAI SDK needs a file path)
        const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'wav'
        const tempPath = join(tmpdir(), `brainwave-stt-${randomUUID()}.${ext}`)
        writeFileSync(tempPath, Buffer.from(audioBuffer))

        try {
          const client = new OpenAI({ apiKey: sttKey, baseURL, timeout: 30_000 })
          const fs = await import('node:fs')

          const transcription = await client.audio.transcriptions.create({
            file: fs.createReadStream(tempPath),
            model,
            response_format: 'text',
          })

          return { text: typeof transcription === 'string' ? transcription : (transcription as unknown as { text: string }).text }
        } finally {
          // Clean up temp file
          try { unlinkSync(tempPath) } catch { /* ignore */ }
        }
      } catch (err) {
        console.error('[STT] Transcription error:', err)
        return { error: err instanceof Error ? err.message : 'Transcription failed' }
      }
    }
  )

  // ─── Model Mode ───
  ipcMain.handle(IPC_CHANNELS.MODEL_MODE_GET, async () => {
    return LLMFactory.getMode()
  })

  ipcMain.handle(IPC_CHANNELS.MODEL_MODE_SET, async (_event, mode: string) => {
    const validModes = ['beast', 'normal', 'economy', 'local']
    if (!validModes.includes(mode)) {
      throw new Error(`Invalid model mode: ${mode}. Must be one of: ${validModes.join(', ')}`)
    }
    LLMFactory.setMode(mode as 'beast' | 'normal' | 'economy' | 'local')

    // Persist the mode to DB so it survives restarts
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      'model_mode',
      JSON.stringify(mode)
    )

    // Apply any saved overrides for the new mode
    applyModelOverrides(db, mode)
  })

  ipcMain.handle(IPC_CHANNELS.MODEL_MODE_GET_CONFIGS, async () => {
    return LLMFactory.getAllAgentConfigs()
  })

  ipcMain.handle(IPC_CHANNELS.MODEL_MODE_GET_PRESETS, async () => {
    return MODEL_MODE_PRESETS
  })

  // ─── OpenRouter Model List ───
  let openRouterModelsCache: Array<{ id: string; name: string }> | null = null

  ipcMain.handle(IPC_CHANNELS.OPENROUTER_LIST_MODELS, async () => {
    if (openRouterModelsCache) return openRouterModelsCache

    try {
      const response = await fetch('https://openrouter.ai/api/v1/models')
      if (!response.ok) throw new Error(`OpenRouter API error: ${response.status}`)
      const data = await response.json() as { data: Array<{ id: string; name: string }> }
      openRouterModelsCache = data.data.map((m) => ({ id: m.id, name: m.name }))
      // Refresh cache after 10 minutes
      setTimeout(() => { openRouterModelsCache = null }, 10 * 60 * 1000)
      return openRouterModelsCache
    } catch (err) {
      console.error('[OpenRouter] Failed to fetch models:', err)
      return []
    }
  })

  // ─── Per-Agent Model Overrides ───
  ipcMain.handle(IPC_CHANNELS.MODEL_OVERRIDE_SET, async (_event, agent: string, modelId: string) => {
    const mode = LLMFactory.getMode()
    const dbKey = `model_overrides_${mode}`

    // Read existing overrides
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(dbKey) as { value: string } | undefined
    const overrides: Record<string, string> = row ? JSON.parse(row.value) : {}

    // Save the override
    overrides[agent] = modelId
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      dbKey,
      JSON.stringify(overrides)
    )

    // Apply immediately
    LLMFactory.setAgentModel(agent, { provider: 'openrouter', model: modelId })
    console.log(`[Model Override] ${agent} → ${modelId} (mode: ${mode})`)
  })

  ipcMain.handle(IPC_CHANNELS.MODEL_OVERRIDE_RESET, async (_event, agent: string) => {
    const mode = LLMFactory.getMode()
    const dbKey = `model_overrides_${mode}`

    // Remove agent from overrides
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(dbKey) as { value: string } | undefined
    const overrides: Record<string, string> = row ? JSON.parse(row.value) : {}
    delete overrides[agent]
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      dbKey,
      JSON.stringify(overrides)
    )

    // Revert to preset default
    const preset = MODEL_MODE_PRESETS[mode]
    if (preset[agent]) {
      LLMFactory.setAgentModel(agent, { ...preset[agent] })
    }
    console.log(`[Model Override] Reset ${agent} to preset default (mode: ${mode})`)
  })

  ipcMain.handle(IPC_CHANNELS.MODEL_OVERRIDE_RESET_ALL, async () => {
    const mode = LLMFactory.getMode()
    const dbKey = `model_overrides_${mode}`

    // Clear all overrides
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      dbKey,
      JSON.stringify({})
    )

    // Reload the preset
    LLMFactory.setMode(mode)
    console.log(`[Model Override] Reset all agents to preset defaults (mode: ${mode})`)
  })

  // ─── LLM Health ───
  ipcMain.handle(IPC_CHANNELS.LLM_CIRCUIT_STATUS, async () => {
    return getAllCircuitBreakerStatus()
  })

  // ─── Ollama ───
  ipcMain.handle(IPC_CHANNELS.OLLAMA_HEALTH, async (_event, host?: string) => {
    return OllamaProvider.healthCheck(host)
  })

  ipcMain.handle(IPC_CHANNELS.OLLAMA_MODELS, async (_event, host?: string) => {
    return OllamaProvider.listModels(host)
  })

  // ─── MCP (Tool Integration) ───
  const mcpRegistry = getMcpRegistry()

  ipcMain.handle(IPC_CHANNELS.MCP_GET_SERVERS, async () => {
    return mcpRegistry.getConfigs()
  })

  ipcMain.handle(IPC_CHANNELS.MCP_ADD_SERVER, async (_event, config: Omit<McpServerConfig, 'id'>) => {
    return mcpRegistry.addServer(config)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_UPDATE_SERVER, async (_event, id: string, updates: Partial<McpServerConfig>) => {
    return mcpRegistry.updateServer(id, updates)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_REMOVE_SERVER, async (_event, id: string) => {
    return mcpRegistry.removeServer(id)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_CONNECT, async (_event, serverId: string) => {
    await mcpRegistry.connect(serverId)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_DISCONNECT, async (_event, serverId: string) => {
    await mcpRegistry.disconnect(serverId)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_GET_STATUSES, async () => {
    return mcpRegistry.getStatuses()
  })

  ipcMain.handle(IPC_CHANNELS.MCP_GET_TOOLS, async () => {
    return mcpRegistry.getAllTools()
  })

  ipcMain.handle(IPC_CHANNELS.MCP_IMPORT_SERVERS, async (_event, json: string) => {
    return importMcpServersFromJson(json, mcpRegistry)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_RELOAD, async () => {
    return mcpRegistry.reload()
  })

  ipcMain.handle(IPC_CHANNELS.MCP_GET_BUNDLED, async () => {
    return mcpRegistry.getBundledPresets()
  })

  ipcMain.handle(IPC_CHANNELS.MCP_TOGGLE_BUNDLED, async (_event, presetId: string, enabled: boolean) => {
    await mcpRegistry.toggleBundledServer(presetId, enabled)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_UPDATE_BUNDLED_CONFIG, async (_event, presetId: string, envVars?: Record<string, string>, configArgs?: Record<string, string>) => {
    mcpRegistry.updateBundledConfig(presetId, envVars, configArgs)
  })

  // ─── Scheduler ───
  const scheduler = getScheduler()

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_GET_JOBS, async () => {
    return scheduler.getJobs()
  })

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_CREATE_JOB, async (_event, input: CreateScheduledJobInput) => {
    return scheduler.createJob(input)
  })

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_UPDATE_JOB, async (_event, id: string, updates: Partial<CreateScheduledJobInput>) => {
    return scheduler.updateJob(id, updates)
  })

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_DELETE_JOB, async (_event, id: string) => {
    return scheduler.deleteJob(id)
  })

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_PAUSE_JOB, async (_event, id: string) => {
    return scheduler.pauseJob(id)
  })

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_RESUME_JOB, async (_event, id: string) => {
    return scheduler.resumeJob(id)
  })

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_TRIGGER_JOB, async (_event, id: string) => {
    scheduler.triggerNow(id)
  })

  // Forward scheduler events to renderer
  scheduler.on('job:updated', (job) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(IPC_CHANNELS.SCHEDULER_JOB_UPDATE, job)
    })
  })

  scheduler.on('job:execute', (payload) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(IPC_CHANNELS.SCHEDULER_JOB_EXECUTED, payload)
    })
  })

  // ─── Chat Sessions ───

  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (_event, title?: string) => {
    const id = randomUUID()
    const now = Date.now()
    const sessionTitle = title || 'New Chat'
    db.run(
      `INSERT INTO chat_sessions (id, title, session_type, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)`,
      id, sessionTitle, now, now
    )
    return { id, title: sessionTitle, type: 'user' as const, createdAt: now, updatedAt: now }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async (_event, type?: string) => {
    const filter = type ? `WHERE cs.session_type = ?` : ''
    const params = type ? [type] : []
    const rows = db.all(
      `SELECT cs.id, cs.title, cs.session_type, cs.created_at, cs.updated_at,
              (SELECT COUNT(*) FROM tasks t WHERE t.session_id = cs.id) as task_count
       FROM chat_sessions cs ${filter} ORDER BY cs.updated_at DESC`,
      ...params
    ) as Array<{ id: string; title: string; session_type: string; created_at: number; updated_at: number; task_count: number }>
    return rows.map((r) => ({
      id: r.id, title: r.title, type: r.session_type as 'user' | 'autonomous', createdAt: r.created_at, updatedAt: r.updated_at, taskCount: r.task_count,
    }))
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, id: string) => {
    db.run(`DELETE FROM chat_sessions WHERE id = ?`, id)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_RENAME, async (_event, id: string, title: string) => {
    const now = Date.now()
    db.run(`UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?`, title, now, id)
    const row = db.get(`SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = ?`, id) as
      { id: string; title: string; created_at: number; updated_at: number } | undefined
    if (!row) return null
    return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_TASKS, async (_event, sessionId: string, limit?: number) => {
    return orchestrator.getTaskHistory(limit ?? 50, sessionId)
  })

  // ─── Calibration / Feedback ───

  ipcMain.handle(IPC_CHANNELS.CALIBRATION_SUBMIT_FEEDBACK, async (_event, runId: string, feedback: 'positive' | 'negative') => {
    getCalibrationTracker().submitFeedback(runId, feedback)
  })

  ipcMain.handle(IPC_CHANNELS.CALIBRATION_GET_REPORT, async () => {
    return getCalibrationTracker().getReport()
  })

  ipcMain.handle(IPC_CHANNELS.CALIBRATION_GET_UNRATED, async (_event, limit?: number) => {
    return getCalibrationTracker().getUnratedRuns(limit)
  })

  // ─── Prompt Versioning ───

  ipcMain.handle(IPC_CHANNELS.PROMPT_LIST_VERSIONS, async () => {
    return getPromptRegistry().listAll()
  })

  // ─── Plugins ───
  const pluginRegistry = getPluginRegistry()

  ipcMain.handle(IPC_CHANNELS.PLUGIN_LIST, async () => {
    return pluginRegistry.getPlugins()
  })

  ipcMain.handle(IPC_CHANNELS.PLUGIN_INSTALL, async (_event, manifest) => {
    return pluginRegistry.install(manifest)
  })

  ipcMain.handle(IPC_CHANNELS.PLUGIN_UPDATE, async (_event, id: string, updates) => {
    return pluginRegistry.update(id, updates)
  })

  ipcMain.handle(IPC_CHANNELS.PLUGIN_REMOVE, async (_event, id: string) => {
    return pluginRegistry.remove(id)
  })

  ipcMain.handle(IPC_CHANNELS.PLUGIN_ENABLE, async (_event, id: string) => {
    return pluginRegistry.enable(id)
  })

  ipcMain.handle(IPC_CHANNELS.PLUGIN_DISABLE, async (_event, id: string) => {
    return pluginRegistry.disable(id)
  })

  // ─── Daily Pulse ───

  ipcMain.handle(IPC_CHANNELS.DAILY_PULSE_GET, async (_event, section: string) => {
    return fetchDailyPulseSection(section as any)
  })

  // ─── Modes ───

  ipcMain.handle(IPC_CHANNELS.MODES_LIST, async () => {
    return getModeRegistry().getAll().map((m) => ({
      slug: m.slug,
      name: m.name,
      description: m.description,
      agentType: m.agentType,
      icon: m.icon,
      builtIn: m.builtIn,
    }))
  })

  ipcMain.handle(IPC_CHANNELS.MODES_GET, async (_event, slug: string) => {
    const m = getModeRegistry().get(slug)
    return m
      ? { slug: m.slug, name: m.name, description: m.description, agentType: m.agentType, icon: m.icon, builtIn: m.builtIn }
      : null
  })

  // ─── Custom Instructions (Phase 12) ───

  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_LIST, async (_event, workDir: string, mode?: string) => {
    const instructions = await getInstructionManager().getInstructions({ workDir, mode })
    return instructions.map((i) => ({
      origin: i.origin,
      filePath: i.filePath,
      content: i.content,
    }))
  })

  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_GET_CONTENT, async (_event, filePath: string) => {
    try {
      const { readFileSync } = require('fs')
      return readFileSync(filePath, 'utf-8')
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_SAVE_CONTENT, async (_event, filePath: string, content: string) => {
    try {
      const fs = require('fs')
      const path = require('path')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, content, 'utf-8')
      // Clear instruction cache so next agent call picks up the new content
      getInstructionManager().clear()
      return true
    } catch (err) {
      console.error('[IPC] Failed to save instruction file:', err)
      return false
    }
  })
}
