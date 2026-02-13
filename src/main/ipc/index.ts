import { ipcMain, app, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '@shared/types'
import type { TaskSubmission, MemoryQuery } from '@shared/types'

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

  // ─── Settings (stubs) ───
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (_event, key: string) => {
    // TODO: Wire to electron-store
    console.log('[IPC] Settings get:', key)
    return null
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event, key: string, value: unknown) => {
    // TODO: Wire to electron-store
    console.log('[IPC] Settings set:', key, value)
  })
}
