import { ipcMain, app, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '@shared/types'
import type { TaskSubmission, MemoryQuery, CreateScheduledJobInput } from '@shared/types'
import { getScheduler } from '../services/scheduler.service'
import { getDatabase } from '../db/database'
import { LLMFactory } from '../llm'

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

  // ─── Agent System (stubs — will wire to real engine) ───
  ipcMain.handle(IPC_CHANNELS.AGENT_SUBMIT_TASK, async (_event, task: TaskSubmission) => {
    // TODO: Wire to Orchestrator
    console.log('[IPC] Task submitted:', task.prompt)
    return { taskId: task.id }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_CANCEL_TASK, async (_event, taskId: string) => {
    // TODO: Wire to Orchestrator
    console.log('[IPC] Task cancelled:', taskId)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_STATUS, async () => {
    // TODO: Wire to AgentPool
    return []
  })

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
