import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type BrainwaveAPI, type TaskSubmission, type MemoryQuery, type TaskUpdate, type AgentLogEntry, type CreateScheduledJobInput, type ScheduledJobInfo, type TaskRecord, type ChatSession } from '@shared/types'

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

  getActiveTasks: () =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_TASKS),

  getTaskHistory: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_TASK_HISTORY, limit),

  getLogHistory: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_LOG_HISTORY, limit),

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

  deleteMemory: (id: string, type: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE, id, type) as Promise<boolean>,

  getMemoryStats: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_STATS),

  getRecentMemories: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_RECENT, limit),

  exportMemories: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_EXPORT),

  importMemories: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_IMPORT),

  // ─── People ───
  getAllPeople: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PEOPLE_GET_ALL),

  getPersonById: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PEOPLE_GET_BY_ID, id),

  searchPeople: (query: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PEOPLE_SEARCH, query),

  createPerson: (input: { name: string; relationship?: string; traits?: string[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PEOPLE_CREATE, input),

  updatePerson: (id: string, input: { name?: string; relationship?: string; traits?: string[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PEOPLE_UPDATE, id, input),

  deletePerson: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PEOPLE_DELETE, id) as Promise<boolean>,

  addPersonInteraction: (id: string, interaction: { date: string; type: string; summary: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PEOPLE_ADD_INTERACTION, id, interaction),

  // ─── Procedural Memory ───
  getAllProcedures: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROCEDURAL_GET_ALL),

  getProceduralById: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROCEDURAL_GET_BY_ID, id),

  searchProcedures: (query: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROCEDURAL_SEARCH, query),

  createProcedure: (input: { name: string; description?: string; steps: Array<{ order: number; action: string }>; tags?: string[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROCEDURAL_CREATE, input),

  deleteProcedure: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROCEDURAL_DELETE, id) as Promise<boolean>,

  // ─── Prospective Memory ───
  getAllProspective: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROSPECTIVE_GET_ALL),

  getPendingProspective: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROSPECTIVE_GET_PENDING),

  createProspective: (input: { intention: string; triggerType: 'time' | 'event' | 'condition'; triggerValue: string; priority?: number; dueAt?: string; tags?: string[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROSPECTIVE_CREATE, input),

  completeProspective: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROSPECTIVE_COMPLETE, id) as Promise<void>,

  deleteProspective: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROSPECTIVE_DELETE, id) as Promise<boolean>,

  // ─── Rules ───
  getSafetyRules: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RULES_GET_SAFETY),

  setSafetyRules: (rules: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.RULES_SET_SAFETY, rules) as Promise<void>,

  getBehaviorRules: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RULES_GET_BEHAVIOR),

  setBehaviorRules: (rules: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.RULES_SET_BEHAVIOR, rules) as Promise<void>,

  getRuleProposals: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RULES_GET_PROPOSALS),

  acceptRuleProposal: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RULES_ACCEPT_PROPOSAL, id) as Promise<boolean>,

  dismissRuleProposal: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RULES_DISMISS_PROPOSAL, id) as Promise<boolean>,

  reloadRules: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RULES_RELOAD) as Promise<void>,

  // ─── Settings ───
  getSetting: <T = unknown>(key: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, key) as Promise<T>,

  setSetting: <T = unknown>(key: string, value: T) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, key, value) as Promise<void>,

  // ─── Model Mode ───
  getModelMode: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_MODE_GET) as Promise<string>,

  setModelMode: (mode: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_MODE_SET, mode) as Promise<void>,

  getModelConfigs: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_MODE_GET_CONFIGS) as Promise<Record<string, { provider: string; model: string }>>,

  // ─── Scheduler ───
  getScheduledJobs: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_GET_JOBS),

  createScheduledJob: (input: CreateScheduledJobInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_CREATE_JOB, input),

  updateScheduledJob: (id: string, updates: Partial<CreateScheduledJobInput>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_UPDATE_JOB, id, updates),

  deleteScheduledJob: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_DELETE_JOB, id),

  pauseScheduledJob: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_PAUSE_JOB, id),

  resumeScheduledJob: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_RESUME_JOB, id),

  triggerScheduledJob: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_TRIGGER_JOB, id),

  onScheduledJobUpdate: (callback: (job: ScheduledJobInfo) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, job: ScheduledJobInfo) => callback(job)
    ipcRenderer.on(IPC_CHANNELS.SCHEDULER_JOB_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SCHEDULER_JOB_UPDATE, handler)
  },

  // ─── Chat Sessions ───
  createSession: (title?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, title) as Promise<ChatSession>,

  listSessions: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST) as Promise<ChatSession[]>,

  deleteSession: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, id) as Promise<boolean>,

  renameSession: (id: string, title: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_RENAME, id, title) as Promise<ChatSession | null>,

  getSessionTasks: (sessionId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET_TASKS, sessionId, limit) as Promise<TaskRecord[]>,

  // LLM Health
  getCircuitBreakerStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_CIRCUIT_STATUS) as Promise<Array<{ state: string; failureCount: number; name: string }>>,

  // Calibration / Feedback
  submitCalibrationFeedback: (runId: string, feedback: 'positive' | 'negative') =>
    ipcRenderer.invoke(IPC_CHANNELS.CALIBRATION_SUBMIT_FEEDBACK, runId, feedback) as Promise<void>,

  getCalibrationReport: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CALIBRATION_GET_REPORT),

  getUnratedRuns: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.CALIBRATION_GET_UNRATED, limit),

  // Prompt Versioning
  getPromptVersions: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROMPT_LIST_VERSIONS),
}

// Expose typed API to renderer
contextBridge.exposeInMainWorld('brainwave', api)
