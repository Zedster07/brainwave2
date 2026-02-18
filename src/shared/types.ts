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
  AGENT_GET_TASKS: 'agent:get-tasks',
  AGENT_GET_TASK_HISTORY: 'agent:get-task-history',
  AGENT_GET_LOG_HISTORY: 'agent:get-log-history',
  AGENT_CLEAR_LOG_HISTORY: 'agent:clear-log-history',

  // Agent events (main → renderer)
  AGENT_EVENT: 'agent:event',
  AGENT_TASK_UPDATE: 'agent:task-update',
  AGENT_LOG: 'agent:log',
  AGENT_STREAM_CHUNK: 'agent:stream-chunk',
  AGENT_ASK_USER: 'agent:ask-user',
  AGENT_USER_RESPONSE: 'agent:user-response',

  // Approval (tool execution gating)
  AGENT_APPROVAL_NEEDED: 'agent:approval-needed',
  AGENT_APPROVAL_RESPONSE: 'agent:approval-response',

  // Checkpoints
  AGENT_GET_CHECKPOINTS: 'agent:get-checkpoints',
  AGENT_ROLLBACK_CHECKPOINT: 'agent:rollback-checkpoint',
  AGENT_CHECKPOINT_CREATED: 'agent:checkpoint-created',

  // Memory
  MEMORY_QUERY: 'memory:query',
  MEMORY_STORE: 'memory:store',
  MEMORY_DELETE: 'memory:delete',
  MEMORY_GET_STATS: 'memory:get-stats',
  MEMORY_GET_RECENT: 'memory:get-recent',
  MEMORY_EXPORT: 'memory:export',
  MEMORY_IMPORT: 'memory:import',

  // People
  PEOPLE_GET_ALL: 'people:get-all',
  PEOPLE_GET_BY_ID: 'people:get-by-id',
  PEOPLE_SEARCH: 'people:search',
  PEOPLE_CREATE: 'people:create',
  PEOPLE_UPDATE: 'people:update',
  PEOPLE_DELETE: 'people:delete',
  PEOPLE_ADD_INTERACTION: 'people:add-interaction',

  // Procedural Memory
  PROCEDURAL_GET_ALL: 'procedural:get-all',
  PROCEDURAL_GET_BY_ID: 'procedural:get-by-id',
  PROCEDURAL_SEARCH: 'procedural:search',
  PROCEDURAL_CREATE: 'procedural:create',
  PROCEDURAL_DELETE: 'procedural:delete',

  // Prospective Memory
  PROSPECTIVE_GET_ALL: 'prospective:get-all',
  PROSPECTIVE_GET_PENDING: 'prospective:get-pending',
  PROSPECTIVE_CREATE: 'prospective:create',
  PROSPECTIVE_COMPLETE: 'prospective:complete',
  PROSPECTIVE_DELETE: 'prospective:delete',

  // Dialog
  DIALOG_SELECT_DIRECTORY: 'dialog:select-directory',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Model Mode
  MODEL_MODE_GET: 'model-mode:get',
  MODEL_MODE_SET: 'model-mode:set',
  MODEL_MODE_GET_CONFIGS: 'model-mode:get-configs',
  MODEL_MODE_GET_PRESETS: 'model-mode:get-presets',
  OPENROUTER_LIST_MODELS: 'openrouter:list-models',
  MODEL_OVERRIDE_SET: 'model-override:set',
  MODEL_OVERRIDE_RESET: 'model-override:reset',
  MODEL_OVERRIDE_RESET_ALL: 'model-override:reset-all',

  // Rules
  RULES_GET_SAFETY: 'rules:get-safety',
  RULES_SET_SAFETY: 'rules:set-safety',
  RULES_GET_BEHAVIOR: 'rules:get-behavior',
  RULES_SET_BEHAVIOR: 'rules:set-behavior',
  RULES_GET_PROPOSALS: 'rules:get-proposals',
  RULES_ACCEPT_PROPOSAL: 'rules:accept-proposal',
  RULES_DISMISS_PROPOSAL: 'rules:dismiss-proposal',
  RULES_RELOAD: 'rules:reload',

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

  // Chat Sessions
  SESSION_CREATE: 'session:create',
  SESSION_LIST: 'session:list',
  SESSION_DELETE: 'session:delete',
  SESSION_RENAME: 'session:rename',
  SESSION_GET_TASKS: 'session:get-tasks',

  // LLM Health
  LLM_CIRCUIT_STATUS: 'llm:circuit-status',

  // Ollama (Local LLM)
  OLLAMA_HEALTH: 'ollama:health',
  OLLAMA_MODELS: 'ollama:models',

  // Auto-Update
  UPDATE_CHECK: 'update:check',
  UPDATE_CHECK_STATUS: 'update:check-status',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  UPDATE_STATUS: 'update:status',  // main → renderer

  // MCP (Tool Integration)
  MCP_GET_SERVERS: 'mcp:get-servers',
  MCP_ADD_SERVER: 'mcp:add-server',
  MCP_UPDATE_SERVER: 'mcp:update-server',
  MCP_REMOVE_SERVER: 'mcp:remove-server',
  MCP_CONNECT: 'mcp:connect',
  MCP_DISCONNECT: 'mcp:disconnect',
  MCP_GET_STATUSES: 'mcp:get-statuses',
  MCP_GET_TOOLS: 'mcp:get-tools',
  MCP_IMPORT_SERVERS: 'mcp:import-servers',
  MCP_RELOAD: 'mcp:reload',
  MCP_GET_BUNDLED: 'mcp:get-bundled',
  MCP_TOGGLE_BUNDLED: 'mcp:toggle-bundled',
  MCP_UPDATE_BUNDLED_CONFIG: 'mcp:update-bundled-config',

  // Calibration / Feedback
  CALIBRATION_SUBMIT_FEEDBACK: 'calibration:submit-feedback',
  CALIBRATION_GET_REPORT: 'calibration:get-report',
  CALIBRATION_GET_UNRATED: 'calibration:get-unrated',

  // Prompt Versioning
  PROMPT_LIST_VERSIONS: 'prompt:list-versions',

  // Plugins
  PLUGIN_LIST: 'plugin:list',
  PLUGIN_INSTALL: 'plugin:install',
  PLUGIN_UPDATE: 'plugin:update',
  PLUGIN_REMOVE: 'plugin:remove',
  PLUGIN_ENABLE: 'plugin:enable',
  PLUGIN_DISABLE: 'plugin:disable',

  // Notifications (main → renderer)
  NOTIFICATION: 'notification:push',

  // Speech-to-Text
  STT_TRANSCRIBE: 'stt:transcribe',

  // Task live state (replay missed events on remount)
  AGENT_GET_TASK_LIVE_STATE: 'agent:get-task-live-state',

  // Daily Pulse
  DAILY_PULSE_GET: 'daily-pulse:get',

  // Modes
  MODES_LIST: 'modes:list',
  MODES_GET: 'modes:get',

  // Instructions (Phase 12)
  INSTRUCTIONS_LIST: 'instructions:list',
  INSTRUCTIONS_GET_CONTENT: 'instructions:get-content',
  INSTRUCTIONS_SAVE_CONTENT: 'instructions:save-content',

  // Context usage (Phase 16 — real-time context window indicator)
  AGENT_CONTEXT_USAGE: 'agent:context-usage',
  AGENT_TOOL_CALL_INFO: 'agent:tool-call-info',

  // Document extraction (renderer → main)
  DOCUMENT_EXTRACT_TEXT: 'document:extract-text',

  // YouTube Player (main → renderer)
  YOUTUBE_PLAY: 'youtube:play',
} as const

// ─── IPC Payload Types ───

export interface TaskSubmission {
  id: string
  prompt: string
  priority?: 'low' | 'normal' | 'high'
  sessionId?: string
  context?: Record<string, unknown>
  images?: ImageAttachment[]
  /** Attached document files — extracted text injected into prompt context */
  documents?: DocumentAttachment[]
  /** Optional mode slug — bypasses triage and routes directly to the mode's agent */
  mode?: string
}

/** Base64-encoded image attachment for vision-capable LLMs */
export interface ImageAttachment {
  /** base64-encoded image data (no data: prefix) */
  data: string
  /** MIME type, e.g. 'image/png', 'image/jpeg', 'image/webp', 'image/gif' */
  mimeType: string
  /** Optional filename for display */
  name?: string
}

/** Document attachment — text extracted in main process */
export interface DocumentAttachment {
  /** Original file name for display */
  name: string
  /** File extension (.pdf, .docx, .xlsx, etc.) */
  extension: string
  /** Extracted text content from the document */
  extractedText: string
  /** Original file size in bytes */
  sizeBytes: number
}

export type TaskStatus = 'queued' | 'planning' | 'executing' | 'completed' | 'failed' | 'cancelled'

/** Live state accumulated in main process — survives renderer navigation */
export interface TaskLiveState {
  currentStep?: string
  activityLog: string[]
  progress?: number
  status: TaskStatus
  /** Accumulated streamed text (non-thinking chunks) — for recovery after navigation */
  streamedText?: string
  /** Accumulated thinking text — for recovery after navigation */
  thinkingText?: string
  /** Tool call info accumulated during execution — for rich block recovery */
  toolCalls?: Array<{
    tool: string
    toolName?: string
    args?: unknown
    success: boolean
    summary?: string
    duration?: number
    resultPreview?: string
    step?: number
    timestamp: number
  }>
}

export interface TaskUpdate {
  taskId: string
  status: TaskStatus
  progress?: number // 0-100
  currentStep?: string
  agentId?: string
  result?: unknown
  error?: string
  timestamp: number
  /** Task list from planner (sent once when plan is created) */
  taskList?: TaskListItem[]
  /** Individual task list item update */
  taskListUpdate?: { itemId: string; status: TaskListItemStatus }
}

// ─── Task List Types (planner progress tracking) ───

export type TaskListItemStatus = 'pending' | 'in-progress' | 'completed' | 'failed'

export interface TaskListItem {
  id: string
  title: string
  agent: string
  status: TaskListItemStatus
  dependsOn: string[]
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

/** Streaming chunk from LLM response — forwarded to renderer for live text display */
export interface StreamChunk {
  taskId: string
  agentType: string
  chunk: string
  isFirst: boolean
  isDone: boolean
  fullText?: string  // only set when isDone=true
}

/** Follow-up question from agent to user */
export interface FollowupQuestion {
  questionId: string
  question: string
  options?: string[]
}

/** Tool execution approval request from agent to user */
export interface ApprovalRequest {
  approvalId: string
  taskId: string
  agentType: string
  tool: string
  args: Record<string, unknown>
  summary: string
  diffPreview?: string
  safetyLevel: 'safe' | 'write' | 'execute' | 'dangerous'
}

/** User's response to an approval request */
export interface ApprovalResponse {
  approvalId: string
  approved: boolean
  feedback?: string
  reason?: string
}

// ─── Context Usage (Phase 16) ───

/** Real-time context window usage for the active task */
export interface ContextUsageInfo {
  taskId: string
  agentType: string
  tokensUsed: number
  budgetTotal: number
  usagePercent: number
  messageCount: number
  condensations: number
  step: number
}

// ─── Structured Tool Call (Phase 16) ───

/** Structured tool call info for rich activity feed cards */
export interface ToolCallInfo {
  taskId: string
  agentType: string
  step: number
  tool: string
  /** Short display name (without server prefix) */
  toolName: string
  args: Record<string, unknown>
  success: boolean
  /** Human-readable summary */
  summary: string
  /** Duration in ms (if available) */
  duration?: number
  /** Result preview (first ~500 chars) */
  resultPreview?: string
  timestamp: number
}

export interface AgentStatus {
  id: string
  type: string
  state: 'idle' | 'thinking' | 'acting' | 'waiting'
  currentTaskId?: string
  model?: string
}

export interface TaskRecord {
  id: string
  prompt: string
  priority: 'low' | 'normal' | 'high'
  status: 'pending' | 'planning' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
  result?: unknown
  error?: string
  createdAt: number
  completedAt?: number
  sessionId?: string
}

export type SessionType = 'user' | 'autonomous'

export interface ChatSession {
  id: string
  title: string
  type: SessionType
  createdAt: number
  updatedAt: number
  taskCount?: number
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
  nickname: string | null
  fullName: string | null
  relationship: string | null
  email: string | null
  phone: string | null
  address: string | null
  birthday: string | null
  age: number | null
  gender: string | null
  occupation: string | null
  company: string | null
  socialLinks: Record<string, string>
  notes: string | null
  traits: string[]
  preferences: Record<string, string>
  interactionHistory: Array<{ date: string; type: string; summary: string; sentiment?: number }>
  lastInteraction: string | null
  createdAt: string
  updatedAt: string
}

export interface ProceduralEntry {
  id: string
  name: string
  description: string | null
  steps: Array<{ order: number; action: string; agent?: string }>
  triggerConditions: string[]
  successRate: number
  executionCount: number
  lastExecuted: string | null
  createdAt: string
  tags: string[]
}

export interface ProspectiveEntry {
  id: string
  intention: string
  triggerType: 'time' | 'event' | 'condition'
  triggerValue: string
  priority: number
  status: 'pending' | 'triggered' | 'completed' | 'expired'
  createdAt: string
  dueAt: string | null
  completedAt: string | null
  tags: string[]
}

export interface MemoryStatsInfo {
  episodic: number
  semantic: number
  procedural: number
  prospective: number
  people: number
}

// ─── Notification Types ───

export type NotificationType = 'task' | 'scheduler' | 'agent' | 'system'

export interface NotificationPayload {
  id: string
  title: string
  body: string
  type: NotificationType
  taskId?: string
  jobId?: string
  timestamp: number
}

// ─── YouTube Player Types ───

export interface YouTubePlayPayload {
  taskId: string
  videoId: string
  title?: string
  playlistId?: string
  startAt?: number
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
  extractDocumentText: (filePath: string) => Promise<{ text: string; sizeBytes: number } | null>
  cancelTask: (taskId: string) => Promise<void>
  getAgentStatus: () => Promise<AgentStatus[]>
  getActiveTasks: () => Promise<TaskRecord[]>
  getTaskHistory: (limit?: number) => Promise<TaskRecord[]>
  getLogHistory: (limit?: number) => Promise<AgentLogEntry[]>
  clearLogHistory: () => Promise<void>

  // Events (main → renderer)
  onTaskUpdate: (callback: (update: TaskUpdate) => void) => () => void
  onAgentLog: (callback: (log: AgentLogEntry) => void) => () => void
  onStreamChunk: (callback: (chunk: StreamChunk) => void) => () => void
  onContextUsage: (callback: (usage: ContextUsageInfo) => void) => () => void
  onToolCallInfo: (callback: (info: ToolCallInfo) => void) => () => void

  // Agent follow-up questions
  onAskUser: (callback: (question: FollowupQuestion) => void) => () => void
  respondToAgent: (questionId: string, response: string) => Promise<void>

  // Tool approval
  onApprovalNeeded: (callback: (request: ApprovalRequest) => void) => () => void
  respondToApproval: (approvalId: string, approved: boolean, feedback?: string, reason?: string) => Promise<void>

  // Memory
  queryMemory: (query: MemoryQuery) => Promise<MemoryEntry[]>
  deleteMemory: (id: string, type: string) => Promise<boolean>
  getMemoryStats: () => Promise<MemoryStatsInfo>
  getRecentMemories: (limit?: number) => Promise<MemoryEntry[]>
  exportMemories: () => Promise<{ success: boolean; filePath?: string; count?: number; error?: string }>
  importMemories: () => Promise<{ success: boolean; imported?: number; skipped?: number; error?: string }>

  // People
  getAllPeople: () => Promise<PersonEntry[]>
  getPersonById: (id: string) => Promise<PersonEntry | null>
  searchPeople: (query: string) => Promise<PersonEntry[]>
  createPerson: (input: { name: string; relationship?: string; traits?: string[] }) => Promise<PersonEntry>
  updatePerson: (id: string, input: { name?: string; relationship?: string; traits?: string[] }) => Promise<PersonEntry | null>
  deletePerson: (id: string) => Promise<boolean>
  addPersonInteraction: (id: string, interaction: { date: string; type: string; summary: string }) => Promise<PersonEntry | null>

  // Procedural Memory
  getAllProcedures: () => Promise<ProceduralEntry[]>
  getProceduralById: (id: string) => Promise<ProceduralEntry | null>
  searchProcedures: (query: string) => Promise<ProceduralEntry[]>
  createProcedure: (input: { name: string; description?: string; steps: Array<{ order: number; action: string }>; tags?: string[] }) => Promise<ProceduralEntry>
  deleteProcedure: (id: string) => Promise<boolean>

  // Prospective Memory
  getAllProspective: () => Promise<ProspectiveEntry[]>
  getPendingProspective: () => Promise<ProspectiveEntry[]>
  createProspective: (input: { intention: string; triggerType: 'time' | 'event' | 'condition'; triggerValue: string; priority?: number; dueAt?: string; tags?: string[] }) => Promise<ProspectiveEntry>
  completeProspective: (id: string) => Promise<void>
  deleteProspective: (id: string) => Promise<boolean>

  // Rules
  getSafetyRules: () => Promise<unknown>
  setSafetyRules: (rules: unknown) => Promise<void>
  getBehaviorRules: () => Promise<unknown>
  setBehaviorRules: (rules: unknown) => Promise<void>
  getRuleProposals: () => Promise<unknown[]>
  acceptRuleProposal: (id: string) => Promise<boolean>
  dismissRuleProposal: (id: string) => Promise<boolean>
  reloadRules: () => Promise<void>

  // Settings
  getSetting: <T = unknown>(key: string) => Promise<T>
  setSetting: <T = unknown>(key: string, value: T) => Promise<void>
  selectDirectory: (title?: string) => Promise<string | null>

  // Model Mode
  getModelMode: () => Promise<string>
  setModelMode: (mode: string) => Promise<void>
  getModelConfigs: () => Promise<Record<string, { provider: string; model: string }>>
  getModelPresets: () => Promise<Record<string, Record<string, { provider: string; model: string }>>>
  listOpenRouterModels: () => Promise<Array<{ id: string; name: string }>>
  setAgentModel: (agent: string, modelId: string) => Promise<void>
  resetAgentModel: (agent: string) => Promise<void>
  resetAllAgentModels: () => Promise<void>

  // Ollama (Local LLM)
  ollamaHealthCheck: (host?: string) => Promise<boolean>
  ollamaListModels: (host?: string) => Promise<Array<{ name: string; size: number; modified: string }>>

  // Scheduler
  getScheduledJobs: () => Promise<ScheduledJobInfo[]>
  createScheduledJob: (input: CreateScheduledJobInput) => Promise<ScheduledJobInfo>
  updateScheduledJob: (id: string, updates: Partial<CreateScheduledJobInput>) => Promise<ScheduledJobInfo | null>
  deleteScheduledJob: (id: string) => Promise<boolean>
  pauseScheduledJob: (id: string) => Promise<boolean>
  resumeScheduledJob: (id: string) => Promise<boolean>
  triggerScheduledJob: (id: string) => Promise<void>
  onScheduledJobUpdate: (callback: (job: ScheduledJobInfo) => void) => () => void

  // Chat Sessions
  createSession: (title?: string) => Promise<ChatSession>
  listSessions: (type?: SessionType) => Promise<ChatSession[]>
  deleteSession: (id: string) => Promise<boolean>
  renameSession: (id: string, title: string) => Promise<ChatSession | null>
  getSessionTasks: (sessionId: string, limit?: number) => Promise<TaskRecord[]>
  onSessionCreated: (callback: (session: ChatSession) => void) => () => void

  // Task live state (replay missed events on remount)
  getTaskLiveState: (taskIds: string[]) => Promise<Record<string, TaskLiveState>>

  // LLM Health
  getCircuitBreakerStatus: () => Promise<Array<{ state: string; failureCount: number; name: string }>>

  // Calibration / Feedback
  submitCalibrationFeedback: (runId: string, feedback: 'positive' | 'negative') => Promise<void>
  getCalibrationReport: () => Promise<CalibrationReportInfo>
  getUnratedRuns: (limit?: number) => Promise<UnratedRunInfo[]>

  // Prompt Versioning
  getPromptVersions: () => Promise<Array<{ name: string; version: string; label: string; hash: string }>>

  // Daily Pulse
  getDailyPulseData: (section: string) => Promise<unknown>

  // Auto-Update
  checkForUpdate: () => Promise<void>
  getUpdateStatus: () => Promise<UpdateStatusInfo>
  downloadUpdate: () => Promise<void>
  installUpdate: () => void
  onUpdateStatus: (callback: (status: UpdateStatusInfo) => void) => () => void

  // MCP (Tool Integration)
  mcpGetServers: () => Promise<McpServerConfigInfo[]>
  mcpAddServer: (config: Omit<McpServerConfigInfo, 'id'>) => Promise<McpServerConfigInfo>
  mcpUpdateServer: (id: string, updates: Partial<McpServerConfigInfo>) => Promise<McpServerConfigInfo | null>
  mcpRemoveServer: (id: string) => Promise<boolean>
  mcpConnect: (serverId: string) => Promise<void>
  mcpDisconnect: (serverId: string) => Promise<void>
  mcpGetStatuses: () => Promise<McpServerStatusInfo[]>
  mcpGetTools: () => Promise<McpToolInfo[]>
  mcpImportServers: (json: string) => Promise<{ imported: number; skipped: number; errors: string[] }>
  mcpReload: () => Promise<{ connected: number; disconnected: number; errors: string[] }>
  mcpGetBundled: () => Promise<BundledMcpServerInfo[]>
  mcpToggleBundled: (presetId: string, enabled: boolean) => Promise<void>
  mcpUpdateBundledConfig: (presetId: string, envVars?: Record<string, string>, configArgs?: Record<string, string>) => Promise<void>

  // Checkpoints
  getCheckpoints: (taskId: string) => Promise<CheckpointInfo[]>
  rollbackToCheckpoint: (taskId: string, checkpointId: string) => Promise<void>
  onCheckpointCreated: (callback: (checkpoint: CheckpointInfo) => void) => () => void

  // Modes
  getModes: () => Promise<ModeInfo[]>
  getMode: (slug: string) => Promise<ModeInfo | null>

  // Custom Instructions (Phase 12)
  getInstructions: (workDir: string, mode?: string) => Promise<InstructionInfo[]>
  getInstructionContent: (filePath: string) => Promise<string | null>
  saveInstructionContent: (filePath: string, content: string) => Promise<boolean>

  // Notifications (main → renderer)
  onNotification: (callback: (notification: NotificationPayload) => void) => () => void

  // Speech-to-Text
  transcribeAudio: (audioBuffer: ArrayBuffer, mimeType: string) => Promise<{ text: string } | { error: string }>

  // Plugins
  pluginList: () => Promise<PluginInfoData[]>
  pluginInstall: (manifest: Omit<PluginInfoData, 'id' | 'enabled' | 'installedAt' | 'updatedAt'>) => Promise<PluginInfoData>
  pluginUpdate: (id: string, updates: Partial<PluginInfoData>) => Promise<PluginInfoData | null>
  pluginRemove: (id: string) => Promise<boolean>
  pluginEnable: (id: string) => Promise<PluginInfoData | null>
  pluginDisable: (id: string) => Promise<PluginInfoData | null>

  // YouTube Player (main → renderer)
  onYouTubePlay: (callback: (payload: YouTubePlayPayload) => void) => () => void
}

// ─── Checkpoint Types ───

export interface CheckpointInfo {
  id: string
  taskId: string
  step: number
  tool: string
  filePath: string
  commitHash: string
  description: string
  createdAt: string
}

// ─── Mode Types ───

export interface ModeInfo {
  slug: string
  name: string
  description: string
  agentType: string
  icon?: string
  builtIn?: boolean
}

// ─── Instruction Types (Phase 12) ───

export interface InstructionInfo {
  /** Origin category */
  origin: 'global' | 'project' | 'mode' | 'mode-rules' | 'global-rules' | 'legacy'
  /** Absolute file path */
  filePath: string
  /** Instruction content */
  content: string
}

// ─── Update Types ───

export interface UpdateStatusInfo {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  progress?: number
  error?: string
  releaseNotes?: string
}

// ─── MCP Types ───

export interface McpServerConfigInfo {
  id: string
  name: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  autoConnect: boolean
  enabled: boolean
  autoApprove?: string[]
  configSource?: 'sqlite' | 'global-file' | 'project-file' | 'bundled'
}

export interface McpServerStatusInfo {
  id: string
  name: string
  state: 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting'
  error?: string
  toolCount: number
  connectedAt?: number
  reconnectAttempts?: number
}

export interface McpToolInfo {
  key: string
  serverId: string
  serverName: string
  name: string
  description: string
}

// ─── Bundled MCP Server Types ───

export interface BundledMcpEnvVarInfo {
  key: string
  label: string
  placeholder: string
  secret: boolean
}

export interface BundledMcpConfigArgInfo {
  key: string
  label: string
  defaultValue: string
  placeholder: string
  description: string
}

export interface BundledMcpServerInfo {
  id: string
  name: string
  description: string
  category: 'search' | 'browser' | 'coding' | 'filesystem' | 'database' | 'utility'
  enabled: boolean
  envVars: BundledMcpEnvVarInfo[]
  configArgs: BundledMcpConfigArgInfo[]
  configuredEnvVars: Record<string, string>
  configuredArgs: Record<string, string>
}

// ─── Plugin Types ───

export interface PluginInfoData {
  id: string
  name: string
  version: string
  description: string
  author?: string
  agentType: string
  capabilities: string[]
  systemPrompt: string
  modelPreference?: {
    provider?: 'openrouter' | 'replicate' | 'ollama'
    model?: string
  }
  icon?: string
  tags?: string[]
  enabled: boolean
  installedAt: number
  updatedAt: number
}

// ─── Calibration Types ───

export interface CalibrationAgentStats {
  agentType: string
  totalRuns: number
  runsWithFeedback: number
  positiveRate: number
  avgConfidence: number
  avgConfidencePositive: number
  avgConfidenceNegative: number
  calibrationError: number
  overConfident: boolean
}

export interface CalibrationBucketInfo {
  range: string
  rangeMin: number
  rangeMax: number
  count: number
  positiveCount: number
  negativeCount: number
  actualPositiveRate: number
}

export interface CalibrationReportInfo {
  generatedAt: number
  agents: CalibrationAgentStats[]
  buckets: CalibrationBucketInfo[]
  recommendedThresholds: {
    escalateBelow: number
    trustAbove: number
  }
}

export interface UnratedRunInfo {
  id: string
  agentType: string
  confidence: number
  output: string
  completedAt: string
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
