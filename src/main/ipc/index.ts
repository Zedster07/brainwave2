import { ipcMain, app, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '@shared/types'
import type { TaskSubmission, MemoryQuery, CreateScheduledJobInput } from '@shared/types'
import { getScheduler } from '../services/scheduler.service'
import { getDatabase } from '../db/database'
import { LLMFactory } from '../llm'
import { getOrchestrator } from '../agents/orchestrator'
import { getAgentPool } from '../agents/agent-pool'
import { getEventBus } from '../agents/event-bus'

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

  ipcMain.handle(IPC_CHANNELS.AGENT_SUBMIT_TASK, async (_event, task: TaskSubmission) => {
    const record = await orchestrator.submitTask(task.prompt, task.priority ?? 'normal')
    return { taskId: record.id }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_CANCEL_TASK, async (_event, taskId: string) => {
    orchestrator.cancelTask(taskId)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_STATUS, async () => {
    const pool = agentPool.getStatus()
    // Return status for each registered agent type
    return pool.agents.map((type) => ({
      id: type,
      type,
      state: 'idle' as const,
      model: LLMFactory.getAgentConfig(type)?.model,
    }))
  })

  // Forward agent events to renderer
  const forwardToRenderer = (channel: string, data: unknown) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(channel, data)
    })
  }

  // Task lifecycle events → renderer
  eventBus.onEvent('task:submitted', (data) => forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
    taskId: data.taskId, status: 'queued', timestamp: Date.now(),
  }))
  eventBus.onEvent('task:planning', (data) => forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
    taskId: data.taskId, status: 'planning', timestamp: Date.now(),
  }))
  eventBus.onEvent('task:progress', (data) => forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
    taskId: data.taskId, status: 'executing', progress: data.progress, currentStep: data.currentStep, timestamp: Date.now(),
  }))
  eventBus.onEvent('task:completed', (data) => forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
    taskId: data.taskId, status: 'completed', result: data.result, timestamp: Date.now(),
  }))
  eventBus.onEvent('task:failed', (data) => forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
    taskId: data.taskId, status: 'failed', error: data.error, timestamp: Date.now(),
  }))
  eventBus.onEvent('task:cancelled', (data) => forwardToRenderer(IPC_CHANNELS.AGENT_TASK_UPDATE, {
    taskId: data.taskId, status: 'cancelled', timestamp: Date.now(),
  }))

  // Agent activity events → renderer log
  eventBus.onEvent('agent:thinking', (data) => forwardToRenderer(IPC_CHANNELS.AGENT_LOG, {
    id: `log_${Date.now()}`, taskId: data.taskId, agentId: data.agentType, agentType: data.agentType,
    level: 'info', message: `Thinking with ${data.model}...`, timestamp: Date.now(),
  }))
  eventBus.onEvent('agent:completed', (data) => forwardToRenderer(IPC_CHANNELS.AGENT_LOG, {
    id: `log_${Date.now()}`, taskId: data.taskId, agentId: data.agentType, agentType: data.agentType,
    level: 'info', message: `Completed (confidence: ${(data.confidence * 100).toFixed(0)}%, tokens: ${data.tokensIn + data.tokensOut})`, timestamp: Date.now(),
  }))
  eventBus.onEvent('agent:error', (data) => forwardToRenderer(IPC_CHANNELS.AGENT_LOG, {
    id: `log_${Date.now()}`, taskId: data.taskId, agentId: data.agentType, agentType: data.agentType,
    level: 'error', message: data.error, timestamp: Date.now(),
  }))

  // ─── Memory (stubs) ───
  ipcMain.handle(IPC_CHANNELS.MEMORY_QUERY, async (_event, _query: MemoryQuery) => {
    // TODO: Wire to MemoryManager
    return []
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_PEOPLE, async () => {
    // TODO: Wire to MemoryManager
    return []
  })

  // ─── Settings (DB-backed) ───
  const db = getDatabase()

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
    }
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
}
