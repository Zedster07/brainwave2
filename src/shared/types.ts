// ─── Shared IPC Types ──────────────────────────────────────
// Types shared between main process and renderer via contextBridge

// ─── IPC Channel Names ───
export const IPC_CHANNELS = {
  // Window controls
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',

  // App
  APP_GET_VERSION: 'app:get-version',
  APP_GET_PATH: 'app:get-path',

  // Agent system
  AGENT_SUBMIT_TASK: 'agent:submit-task',
  AGENT_CANCEL_TASK: 'agent:cancel-task',
  AGENT_GET_STATUS: 'agent:get-status',

  // Agent events (main → renderer)
  AGENT_EVENT: 'agent:event',
  AGENT_TASK_UPDATE: 'agent:task-update',
  AGENT_LOG: 'agent:log',

  // Memory
  MEMORY_QUERY: 'memory:query',
  MEMORY_STORE: 'memory:store',
  MEMORY_GET_PEOPLE: 'memory:get-people',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Scheduler
  SCHEDULER_GET_JOBS: 'scheduler:get-jobs',
  SCHEDULER_CREATE_JOB: 'scheduler:create-job',
  SCHEDULER_UPDATE_JOB: 'scheduler:update-job',
  SCHEDULER_DELETE_JOB: 'scheduler:delete-job',
  SCHEDULER_PAUSE_JOB: 'scheduler:pause-job',
  SCHEDULER_RESUME_JOB: 'scheduler:resume-job',
  SCHEDULER_TRIGGER_JOB: 'scheduler:trigger-job',
  SCHEDULER_JOB_UPDATE: 'scheduler:job-update',       // main → renderer
  SCHEDULER_JOB_EXECUTED: 'scheduler:job-executed',   // main → renderer
} as const

// ─── IPC Payload Types ───

export interface TaskSubmission {
  id: string
  prompt: string
  priority?: 'low' | 'normal' | 'high'
  context?: Record<string, unknown>
}

export type TaskStatus = 'queued' | 'planning' | 'executing' | 'completed' | 'failed' | 'cancelled'

export interface TaskUpdate {
  taskId: string
  status: TaskStatus
  progress?: number // 0-100
  currentStep?: string
  agentId?: string
  result?: unknown
  error?: string
  timestamp: number
}

export interface AgentLogEntry {
  id: string
  taskId: string
  agentId: string
  agentType: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  data?: unknown
  timestamp: number
}

export interface AgentStatus {
  id: string
  type: string
  state: 'idle' | 'thinking' | 'acting' | 'waiting'
  currentTaskId?: string
  model?: string
}

export interface MemoryQuery {
  query: string
  type?: 'episodic' | 'semantic' | 'procedural' | 'people'
  limit?: number
}

export interface MemoryEntry {
  id: string
  type: string
  content: string
  importance: number
  createdAt: string
  lastAccessed: string
  accessCount: number
  tags: string[]
}

export interface PersonEntry {
  id: string
  name: string
  relationship: string
  traits: string[]
  preferences: Record<string, string>
  lastInteraction: string
  interactionCount: number
}

// ─── Brainwave API (exposed to renderer via preload) ───

export interface BrainwaveAPI {
  // Window controls
  minimizeWindow: () => void
  maximizeWindow: () => void
  closeWindow: () => void

  // App info
  getVersion: () => Promise<string>

  // Agent system
  submitTask: (task: TaskSubmission) => Promise<{ taskId: string }>
  cancelTask: (taskId: string) => Promise<void>
  getAgentStatus: () => Promise<AgentStatus[]>

  // Events (main → renderer)
  onTaskUpdate: (callback: (update: TaskUpdate) => void) => () => void
  onAgentLog: (callback: (log: AgentLogEntry) => void) => () => void

  // Memory
  queryMemory: (query: MemoryQuery) => Promise<MemoryEntry[]>
  getPeople: () => Promise<PersonEntry[]>

  // Settings
  getSetting: <T = unknown>(key: string) => Promise<T>
  setSetting: <T = unknown>(key: string, value: T) => Promise<void>

  // Scheduler
  getScheduledJobs: () => Promise<ScheduledJobInfo[]>
  createScheduledJob: (input: CreateScheduledJobInput) => Promise<ScheduledJobInfo>
  updateScheduledJob: (id: string, updates: Partial<CreateScheduledJobInput>) => Promise<ScheduledJobInfo | null>
  deleteScheduledJob: (id: string) => Promise<boolean>
  pauseScheduledJob: (id: string) => Promise<boolean>
  resumeScheduledJob: (id: string) => Promise<boolean>
  triggerScheduledJob: (id: string) => Promise<void>
  onScheduledJobUpdate: (callback: (job: ScheduledJobInfo) => void) => () => void
}

// ─── Scheduler Types ───

export type ScheduleType = 'once' | 'cron' | 'interval'
export type ScheduledJobStatus = 'active' | 'paused' | 'completed' | 'failed'

export interface ScheduledJobInfo {
  id: string
  name: string
  description?: string
  taskPrompt: string
  taskPriority: 'low' | 'normal' | 'high'
  type: ScheduleType
  cronExpression?: string
  intervalMs?: number
  runAt?: number
  status: ScheduledJobStatus
  nextRunAt: number | null
  lastRunAt: number | null
  lastRunResult?: 'success' | 'failure'
  runCount: number
  maxRuns?: number
  createdAt: number
  updatedAt: number
}

export interface CreateScheduledJobInput {
  name: string
  description?: string
  taskPrompt: string
  taskPriority?: 'low' | 'normal' | 'high'
  type: ScheduleType
  cronExpression?: string
  intervalMs?: number
  runAt?: number
  maxRuns?: number
}

// Augment window type
declare global {
  interface Window {
    brainwave: BrainwaveAPI
  }
}
