import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type BrainwaveAPI, type TaskSubmission, type MemoryQuery, type TaskUpdate, type AgentLogEntry } from '@shared/types'

const api: BrainwaveAPI = {
  // ─── Window Controls ───
  minimizeWindow: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE),
  maximizeWindow: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MAXIMIZE),
  closeWindow: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE),

  // ─── App Info ───
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),

  // ─── Agent System ───
  submitTask: (task: TaskSubmission) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SUBMIT_TASK, task),

  cancelTask: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_CANCEL_TASK, taskId),

  getAgentStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_STATUS),

  // ─── Events (main → renderer) ───
  onTaskUpdate: (callback: (update: TaskUpdate) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, update: TaskUpdate) => callback(update)
    ipcRenderer.on(IPC_CHANNELS.AGENT_TASK_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TASK_UPDATE, handler)
  },

  onAgentLog: (callback: (log: AgentLogEntry) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, log: AgentLogEntry) => callback(log)
    ipcRenderer.on(IPC_CHANNELS.AGENT_LOG, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_LOG, handler)
  },

  // ─── Memory ───
  queryMemory: (query: MemoryQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_QUERY, query),

  getPeople: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_PEOPLE),

  // ─── Settings ───
  getSetting: <T = unknown>(key: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, key) as Promise<T>,

  setSetting: <T = unknown>(key: string, value: T) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, key, value) as Promise<void>,
}

// Expose typed API to renderer
contextBridge.exposeInMainWorld('brainwave', api)
