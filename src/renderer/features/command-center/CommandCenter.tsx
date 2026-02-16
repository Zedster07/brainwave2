import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Send, Sparkles, Clock, CheckCircle2, XCircle, Loader2, AlertTriangle, Ban, Plus, MessageSquare, Trash2, Pencil, PanelLeftClose, PanelLeft, Mic, MicOff, Volume2, VolumeX, Paperclip, X, ImageIcon, Bot, ShieldCheck, ShieldX, Undo2 } from 'lucide-react'
import { Markdown } from '../../components/Markdown'
import { useVoice } from '../../hooks/useVoice'
import { ToolCallCard, type ToolCallCardData } from './ToolCallCard'
import { ContextIndicator, type ContextUsageData } from './ContextIndicator'
import { StreamingContent } from './StreamingCodeCard'
import type { TaskUpdate, TaskStatus, ChatSession, TaskLiveState, ImageAttachment, TaskListItem, TaskListItemStatus, StreamChunk, FollowupQuestion, ApprovalRequest, CheckpointInfo, ModeInfo, ContextUsageInfo, ToolCallInfo } from '@shared/types'

interface LiveTask {
  id: string
  prompt: string
  status: TaskStatus
  currentStep?: string
  activityLog: string[]
  progress?: number
  result?: unknown
  error?: string
  timestamp: number
  taskList?: TaskListItem[]
  /** Live streaming text from LLM — accumulated as chunks arrive */
  streamingText?: string
  /** Pending follow-up question from agent */
  followupQuestion?: FollowupQuestion
  /** Pending approval request from agent */
  approvalRequest?: ApprovalRequest
  /** Checkpoints created during this task */
  checkpoints?: CheckpointInfo[]
  /** Structured tool call data for rich tool cards */
  toolCalls?: ToolCallCardData[]
  /** Latest context usage info for this task */
  contextUsage?: ContextUsageData
}

export function CommandCenter() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [tasks, setTasks] = useState<LiveTask[]>([])
  const [loaded, setLoaded] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Voice input/output
  const voice = useVoice({
    onResult: (transcript) => setInput((prev) => (prev ? prev + ' ' : '') + transcript),
  })

  // Image attachments
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Modes
  const [modes, setModes] = useState<ModeInfo[]>([])
  const [selectedMode, setSelectedMode] = useState<string | undefined>(undefined)
  const MAX_IMAGES = 5
  const MAX_IMAGE_SIZE = 4 * 1024 * 1024 // 4MB per image

  const fileToImageAttachment = useCallback((file: File): Promise<ImageAttachment | null> => {
    return new Promise((resolve) => {
      if (!file.type.startsWith('image/')) { resolve(null); return }
      if (file.size > MAX_IMAGE_SIZE) {
        console.warn(`[CommandCenter] Image too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`)
        resolve(null)
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const base64 = dataUrl.split(',')[1]
        if (!base64) { resolve(null); return }
        resolve({ data: base64, mimeType: file.type, name: file.name })
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
  }, [])

  const addImages = useCallback(async (files: File[]) => {
    const remaining = MAX_IMAGES - attachedImages.length
    if (remaining <= 0) return
    const toProcess = files.slice(0, remaining)
    const results = await Promise.all(toProcess.map(fileToImageAttachment))
    const valid = results.filter((r): r is ImageAttachment => r !== null)
    if (valid.length > 0) {
      setAttachedImages((prev) => [...prev, ...valid].slice(0, MAX_IMAGES))
    }
  }, [attachedImages.length, fileToImageAttachment])

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // Auto-scroll to bottom when tasks change
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    })
  }, [])

  // Session state
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [autoSessions, setAutoSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarTab, setSidebarTab] = useState<'user' | 'autonomous'>('user')
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  // Load sessions on mount
  useEffect(() => {
    // Load both types in parallel
    Promise.all([
      window.brainwave.listSessions('user'),
      window.brainwave.listSessions('autonomous'),
    ]).then(([userList, autoList]) => {
      setSessions(userList)
      setAutoSessions(autoList)

      // Check for deep-link session from URL (?session=<id>)
      const deepLinkSession = searchParams.get('session')
      if (deepLinkSession) {
        // Check which list the session belongs to
        const inUser = userList.some((s) => s.id === deepLinkSession)
        const inAuto = autoList.some((s) => s.id === deepLinkSession)
        if (inUser) {
          setSidebarTab('user')
          setActiveSessionId(deepLinkSession)
        } else if (inAuto) {
          setSidebarTab('autonomous')
          setActiveSessionId(deepLinkSession)
        }
        setSearchParams({}, { replace: true })
      } else if (userList.length > 0) {
        setActiveSessionId(userList[0].id)
      }
    }).catch(console.error)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Load available modes on mount
  useEffect(() => {
    window.brainwave.getModes().then(setModes).catch(console.error)
  }, [])

  // Listen for sessions created by scheduled jobs (from main process)
  useEffect(() => {
    const unsubscribe = window.brainwave.onSessionCreated((session) => {
      if (session.type === 'autonomous') {
        setAutoSessions((prev) => [session, ...prev])
      } else {
        setSessions((prev) => [session, ...prev])
      }
    })
    return unsubscribe
  }, [])

  // Load tasks when active session changes
  useEffect(() => {
    if (!activeSessionId) {
      // No session selected — show empty state
      setTasks([])
      setLoaded(true)
      return
    }
    setLoaded(false)
    window.brainwave.getSessionTasks(activeSessionId, 50).then(async (history) => {
      const loadedTasks: LiveTask[] = history.reverse().map((h) => ({
        id: h.id,
        prompt: h.prompt,
        status: h.status,
        result: h.result,
        error: h.error,
        activityLog: [] as string[],
        timestamp: h.createdAt,
      }))

      // Replay missed live state for active tasks (survives navigation)
      const activeIds = loadedTasks
        .filter((t) => t.status === 'queued' || t.status === 'planning' || t.status === 'executing')
        .map((t) => t.id)

      if (activeIds.length > 0) {
        try {
          const liveStates = await window.brainwave.getTaskLiveState(activeIds)
          for (const task of loadedTasks) {
            const live = liveStates[task.id]
            if (live) {
              task.currentStep = live.currentStep
              task.activityLog = live.activityLog
              task.progress = live.progress
              // Use the live status in case it advanced since DB was written
              if (live.status) task.status = live.status
            }
          }
        } catch (err) {
          console.warn('[CommandCenter] Failed to fetch task live state:', err)
        }
      }

      setTasks(loadedTasks)
      setLoaded(true)
      scrollToBottom()
    }).catch((err) => {
      console.warn('[CommandCenter] Failed to load session tasks:', err)
      setLoaded(true)
    })
  }, [activeSessionId])

  // Subscribe to real-time task updates
  useEffect(() => {
    const unsubscribe = window.brainwave.onTaskUpdate((update: TaskUpdate) => {
      setTasks((prev) => {
        const existing = prev.find((t) => t.id === update.taskId)
        if (existing) {
          return prev.map((t) => {
            if (t.id !== update.taskId) return t
            const activityLog = [...t.activityLog]
            if (update.currentStep && update.currentStep !== t.currentStep) {
              activityLog.push(update.currentStep)
            }
            // Merge task list updates
            let taskList = t.taskList
            if (update.taskList) {
              taskList = update.taskList
            } else if (update.taskListUpdate && taskList) {
              taskList = taskList.map((item) =>
                item.id === update.taskListUpdate!.itemId
                  ? { ...item, status: update.taskListUpdate!.status }
                  : item
              )
            }
            return {
              ...t,
              status: update.status,
              currentStep: update.currentStep,
              progress: update.progress,
              result: update.result ?? t.result,
              error: update.error ?? t.error,
              activityLog,
              taskList,
              timestamp: update.timestamp,
            }
          })
        }
        return prev
      })
    })
    return unsubscribe
  }, [])

  // Subscribe to streaming LLM chunks for real-time text display
  useEffect(() => {
    const unsubscribe = window.brainwave.onStreamChunk((chunk: StreamChunk) => {
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== chunk.taskId) return t
          if (chunk.isDone) {
            // Stream finished — clear streaming text (final result comes via onTaskUpdate)
            return { ...t, streamingText: undefined }
          }
          return {
            ...t,
            streamingText: chunk.isFirst ? chunk.chunk : (t.streamingText ?? '') + chunk.chunk,
          }
        })
      )
      scrollToBottom()
    })
    return unsubscribe
  }, [scrollToBottom])

  // Subscribe to agent follow-up questions
  useEffect(() => {
    const unsubscribe = window.brainwave.onAskUser((question: FollowupQuestion) => {
      // Find the active task and attach the question to it
      setTasks((prev) => {
        const activeIdx = prev.findIndex(t => t.status === 'executing' || t.status === 'planning')
        if (activeIdx === -1) return prev
        const updated = [...prev]
        updated[activeIdx] = { ...updated[activeIdx], followupQuestion: question }
        return updated
      })
      scrollToBottom()
    })
    return unsubscribe
  }, [scrollToBottom])

  const handleFollowupResponse = useCallback(async (questionId: string, response: string) => {
    try {
      await window.brainwave.respondToAgent(questionId, response)
      // Clear the question from UI
      setTasks((prev) =>
        prev.map((t) => t.followupQuestion?.questionId === questionId
          ? { ...t, followupQuestion: undefined }
          : t
        )
      )
    } catch (err) {
      console.error('[CommandCenter] Failed to respond to agent:', err)
    }
  }, [])

  // Subscribe to tool approval requests
  useEffect(() => {
    const unsubscribe = window.brainwave.onApprovalNeeded((request: ApprovalRequest) => {
      setTasks((prev) => {
        const activeIdx = prev.findIndex(t => t.status === 'executing' || t.status === 'planning')
        if (activeIdx === -1) return prev
        const updated = [...prev]
        updated[activeIdx] = { ...updated[activeIdx], approvalRequest: request }
        return updated
      })
      scrollToBottom()
    })
    return unsubscribe
  }, [scrollToBottom])

  // Subscribe to checkpoint creation events
  useEffect(() => {
    const unsubscribe = window.brainwave.onCheckpointCreated((checkpoint: CheckpointInfo) => {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === checkpoint.taskId
            ? { ...t, checkpoints: [...(t.checkpoints ?? []), checkpoint] }
            : t
        )
      )
    })
    return unsubscribe
  }, [])

  // Subscribe to structured tool call info (rich tool cards)
  useEffect(() => {
    const unsubscribe = window.brainwave.onToolCallInfo((info: ToolCallInfo) => {
      const cardData: ToolCallCardData = {
        taskId: info.taskId,
        agentType: info.agentType,
        step: info.step,
        tool: info.tool,
        toolName: info.toolName,
        args: info.args,
        success: info.success,
        summary: info.summary,
        duration: info.duration,
        resultPreview: info.resultPreview,
        timestamp: info.timestamp ?? Date.now(),
      }
      setTasks((prev) =>
        prev.map((t) =>
          t.id === info.taskId
            ? { ...t, toolCalls: [...(t.toolCalls ?? []), cardData] }
            : t
        )
      )
    })
    return unsubscribe
  }, [])

  // Subscribe to context usage updates (context window indicator)
  useEffect(() => {
    const unsubscribe = window.brainwave.onContextUsage((usage: ContextUsageInfo) => {
      const usageData: ContextUsageData = {
        taskId: usage.taskId,
        agentType: usage.agentType,
        tokensUsed: usage.tokensUsed,
        budgetTotal: usage.budgetTotal,
        usagePercent: usage.usagePercent,
        messageCount: usage.messageCount,
        condensations: usage.condensations,
        step: usage.step,
      }
      setTasks((prev) =>
        prev.map((t) =>
          t.id === usage.taskId
            ? { ...t, contextUsage: usageData }
            : t
        )
      )
    })
    return unsubscribe
  }, [])

  const handleApprovalResponse = useCallback(async (approvalId: string, approved: boolean, feedback?: string, reason?: string) => {
    try {
      await window.brainwave.respondToApproval(approvalId, approved, feedback, reason)
      // Clear the approval request from UI
      setTasks((prev) =>
        prev.map((t) => t.approvalRequest?.approvalId === approvalId
          ? { ...t, approvalRequest: undefined }
          : t
        )
      )
    } catch (err) {
      console.error('[CommandCenter] Failed to respond to approval:', err)
    }
  }, [])

  const handleNewChat = useCallback(async () => {
    // Create a new session immediately, switch to it
    try {
      const session = await window.brainwave.createSession('New Chat')
      setSessions((prev) => [session, ...prev])
      setActiveSessionId(session.id)
      setSidebarTab('user')
      setTasks([])
      inputRef.current?.focus()
    } catch (err) {
      console.error('[CommandCenter] Failed to create session:', err)
    }
  }, [])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if ((!input.trim() && attachedImages.length === 0) || submitting) return

    const prompt = input.trim()
    const images = attachedImages.length > 0 ? [...attachedImages] : undefined
    setInput('')
    setAttachedImages([])
    // Reset textarea height
    if (inputRef.current) inputRef.current.style.height = 'auto'
    setSubmitting(true)

    try {
      // Auto-create session if none active
      let sessionId = activeSessionId
      if (!sessionId) {
        const session = await window.brainwave.createSession(prompt.slice(0, 60) || 'Image chat')
        setSessions((prev) => [session, ...prev])
        setActiveSessionId(session.id)
        sessionId = session.id
      } else {
        // Auto-title: if this is the first message in the session, update title
        if (tasks.length === 0) {
          const title = (prompt || 'Image chat').slice(0, 60)
          const updated = await window.brainwave.renameSession(sessionId, title)
          if (updated) {
            setSessions((prev) => prev.map((s) => s.id === sessionId ? { ...s, title: updated.title } : s))
          }
        }
      }

      const displayPrompt = images
        ? `${prompt || 'Analyze image(s)'}${images.length > 0 ? ` [${images.length} image${images.length > 1 ? 's' : ''}]` : ''}`
        : prompt

      const { taskId } = await window.brainwave.submitTask({
        id: crypto.randomUUID(),
        prompt: prompt || 'Analyze the attached image(s)',
        priority: 'normal',
        sessionId,
        images,
        mode: selectedMode,
      })

      setTasks((prev) => [
        ...prev,
        { id: taskId, prompt: displayPrompt, status: 'queued', activityLog: [], timestamp: Date.now() },
      ])
      scrollToBottom()
    } catch (err) {
      console.error('[CommandCenter] Submit failed:', err)
      setTasks((prev) => [
        ...prev,
        { id: crypto.randomUUID(), prompt, status: 'failed', activityLog: [], error: err instanceof Error ? err.message : 'Submission failed', timestamp: Date.now() },
      ])
      scrollToBottom()
    } finally {
      setSubmitting(false)
      inputRef.current?.focus()
    }
  }, [input, submitting, activeSessionId, tasks.length, attachedImages])

  const handleCancel = useCallback(async (taskId: string) => {
    try {
      await window.brainwave.cancelTask(taskId)
    } catch (err) {
      console.error('[CommandCenter] Cancel failed:', err)
    }
  }, [])

  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await window.brainwave.deleteSession(id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
      setAutoSessions((prev) => prev.filter((s) => s.id !== id))
      if (activeSessionId === id) {
        setActiveSessionId(null)
        setTasks([])
      }
    } catch (err) {
      console.error('[CommandCenter] Failed to delete session:', err)
    }
  }, [activeSessionId])

  const handleRenameSession = useCallback(async (id: string, title: string) => {
    if (!title.trim()) {
      setEditingSessionId(null)
      return
    }
    try {
      const updated = await window.brainwave.renameSession(id, title.trim())
      if (updated) {
        setSessions((prev) => prev.map((s) => s.id === id ? { ...s, title: updated.title } : s))
        setAutoSessions((prev) => prev.map((s) => s.id === id ? { ...s, title: updated.title } : s))
      }
    } catch (err) {
      console.error('[CommandCenter] Failed to rename session:', err)
    }
    setEditingSessionId(null)
  }, [])

  const activeSession = sessions.find((s) => s.id === activeSessionId) || autoSessions.find((s) => s.id === activeSessionId)

  // Helper: which list to show in the sidebar
  const visibleSessions = sidebarTab === 'user' ? sessions : autoSessions

  return (
    <div className="flex h-full">
      {/* Session Sidebar */}
      {sidebarOpen && (
        <div style={{
            minWidth:"325px",
        }} className="w-64 flex-shrink-0 border-r border-white/[0.06] flex flex-col bg-white/[0.01]">
          {/* Sidebar Header with Tabs */}
          <div className="border-b border-white/[0.06]">
            <div className="p-3 flex items-center justify-between">
              <div className="flex items-center gap-0.5 bg-white/[0.04] rounded-lg p-0.5">
                <button
                  onClick={() => setSidebarTab('user')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1.5
                    ${sidebarTab === 'user'
                      ? 'bg-white/[0.1] text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-300'
                    }`}
                >
                  <MessageSquare className="w-3 h-3" />
                  Chats
                  {sessions.length > 0 && (
                    <span className="text-[10px] opacity-60">{sessions.length}</span>
                  )}
                </button>
                <button
                  onClick={() => setSidebarTab('autonomous')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1.5
                    ${sidebarTab === 'autonomous'
                      ? 'bg-white/[0.1] text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-300'
                    }`}
                >
                  <Bot className="w-3 h-3" />
                  Auto
                  {autoSessions.length > 0 && (
                    <span className="text-[10px] opacity-60">{autoSessions.length}</span>
                  )}
                </button>
              </div>
              <div className="flex items-center gap-1">
                {sidebarTab === 'user' && (
                  <button
                    onClick={handleNewChat}
                    className="p-1.5 rounded-md hover:bg-white/[0.06] text-gray-400 hover:text-white transition-colors"
                    title="New Chat"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="p-1.5 rounded-md hover:bg-white/[0.06] text-gray-400 hover:text-white transition-colors"
                  title="Close sidebar"
                >
                  <PanelLeftClose className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Session List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {visibleSessions.length === 0 ? (
              <p className="text-[11px] text-gray-600 text-center py-6">
                {sidebarTab === 'user' ? 'No chats yet' : 'No autonomous sessions yet'}
              </p>
            ) : (
              visibleSessions.map((session) => (
                <div
                  key={session.id}
                  className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors
                    ${activeSessionId === session.id
                      ? 'bg-accent/10 text-white'
                      : 'text-gray-400 hover:bg-white/[0.04] hover:text-gray-200'
                    }`}
                  onClick={() => { setActiveSessionId(session.id); setEditingSessionId(null) }}
                >
                  {sidebarTab === 'autonomous'
                    ? <Bot className="w-3.5 h-3.5 flex-shrink-0 opacity-60 text-purple-400" />
                    : <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
                  }
                  {editingSessionId === session.id ? (
                    <input
                      autoFocus
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onBlur={() => handleRenameSession(session.id, editTitle)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameSession(session.id, editTitle)
                        if (e.key === 'Escape') setEditingSessionId(null)
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 bg-transparent text-xs text-white border-b border-accent/40 outline-none py-0.5 min-w-0"
                    />
                  ) : (
                    <span className="flex-1 text-xs truncate">{session.title}</span>
                  )}

                  {/* Actions — show on hover */}
                  <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingSessionId(session.id)
                        setEditTitle(session.title)
                      }}
                      className="p-1 rounded hover:bg-white/[0.08] text-gray-500 hover:text-gray-300"
                      title="Rename"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteSession(session.id)
                      }}
                      className="p-1 rounded hover:bg-white/[0.08] text-gray-500 hover:text-red-400"
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar — sidebar toggle + session title */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-white/[0.06] flex-shrink-0">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-1.5 rounded-md hover:bg-white/[0.06] text-gray-400 hover:text-white transition-colors"
              title="Open sidebar"
            >
              <PanelLeft className="w-4 h-4" />
            </button>
          )}
          {activeSession ? (
            <h3 className="text-sm font-medium text-white truncate">{activeSession.title}</h3>
          ) : (
            <h3 className="text-sm text-gray-500">Select or start a new chat</h3>
          )}
        </div>

        <div className="flex flex-col flex-1 max-w-4xl mx-auto w-full min-h-0">
          {/* Welcome state when no session */}
          {!activeSessionId && (
            <div className="min-h-full flex-1 p-4 flex items-center justify-center">
              <div className="text-center mt-4 p-4">
                <div className="inline-flex mt-4 p-4 items-center justify-center w-16 h-16 rounded-2xl bg-accent/10 mb-4 glow-accent">
                  <Sparkles className="w-8 h-8 text-accent" />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">What should I work on?</h2>
                <p className="text-gray-500 text-sm max-w-md mx-auto mb-6">
                  Describe a task and I'll plan, delegate to specialized agents, and execute it autonomously.
                </p>
                <button
                  onClick={handleNewChat}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium
                             hover:bg-accent/90 transition-all active:scale-[0.98]"
                >
                  <Plus className="w-4 h-4" /> New Chat
                </button>
              </div>
            </div>
          )}

          {/* Active session: task list + input */}
          {activeSessionId && (
            <>
              {/* Task Activity — scrollable area */}
              <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-4 pb-24 pt-4">
                {!loaded ? (
                  <div className="flex items-center justify-center py-12 text-gray-500">
                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                  </div>
                ) : tasks.length === 0 ? (
                  <div className="min-h-full flex items-center justify-center">
                    <div className="text-center">
                      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent/10 mb-4 glow-accent">
                        <Sparkles className="w-8 h-8 text-accent" />
                      </div>
                      <h2 className="text-2xl font-bold text-white mb-2">What should I work on?</h2>
                      <p className="text-gray-500 text-sm max-w-md mx-auto">
                        Describe a task and I'll plan, delegate to specialized agents, and execute it autonomously.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {tasks.map((task) => (
                      <TaskCard key={task.id} task={task} onCancel={handleCancel} onFollowupResponse={handleFollowupResponse} onApprovalResponse={handleApprovalResponse} />
                    ))}
                  </div>
                )}
              </div>

              {/* Task Input — pinned to bottom */}
              <div className="sticky bottom-0 z-10 pt-2 pb-4 px-4 bg-gradient-to-t from-primary via-primary to-transparent">
                <form
                  onSubmit={handleSubmit}
                  className="glass-card p-4"
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
                    if (files.length > 0) addImages(files)
                  }}
                >
                  {/* Interim transcript indicator */}
                  {voice.isListening && voice.interimTranscript && (
                    <div className="mb-2 px-3 py-1.5 text-xs text-gray-400 italic bg-white/[0.02] rounded-lg border border-white/[0.05] truncate">
                      {voice.interimTranscript}…
                    </div>
                  )}

                  {/* Image preview thumbnails */}
                  {attachedImages.length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-2">
                      {attachedImages.map((img, i) => (
                        <div key={i} className="relative group">
                          <img
                            src={`data:${img.mimeType};base64,${img.data}`}
                            alt={img.name || `Image ${i + 1}`}
                            className="w-16 h-16 rounded-lg object-cover border border-white/[0.1] bg-white/[0.03]"
                          />
                          <button
                            type="button"
                            onClick={() => removeImage(i)}
                            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500/90 text-white flex items-center justify-center
                                       opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
                            title="Remove image"
                          >
                            <X className="w-3 h-3" />
                          </button>
                          {img.name && (
                            <p className="text-[9px] text-gray-500 mt-0.5 truncate max-w-[64px] text-center">{img.name}</p>
                          )}
                        </div>
                      ))}
                      {attachedImages.length < MAX_IMAGES && (
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="w-16 h-16 rounded-lg border border-dashed border-white/[0.1] bg-white/[0.02]
                                     flex items-center justify-center text-gray-500 hover:text-gray-300 hover:border-white/[0.2] transition-colors"
                          title="Add more images"
                        >
                          <Plus className="w-5 h-5" />
                        </button>
                      )}
                    </div>
                  )}

                  {/* Hidden file input */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const files = Array.from(e.target.files || [])
                      if (files.length > 0) addImages(files)
                      e.target.value = '' // Reset so same file can be picked again
                    }}
                  />

                  {/* Mode selector pills */}
                  {modes.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => setSelectedMode(undefined)}
                        className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all
                          ${!selectedMode
                            ? 'bg-accent/20 text-accent border border-accent/40'
                            : 'bg-white/[0.04] text-gray-400 border border-white/[0.08] hover:text-white hover:border-white/20'
                          }`}
                      >
                        🎯 Auto
                      </button>
                      {modes.filter((m) => m.slug !== 'orchestrator').map((m) => (
                        <button
                          key={m.slug}
                          type="button"
                          onClick={() => setSelectedMode(m.slug === selectedMode ? undefined : m.slug)}
                          title={m.description}
                          className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all
                            ${selectedMode === m.slug
                              ? 'bg-accent/20 text-accent border border-accent/40'
                              : 'bg-white/[0.04] text-gray-400 border border-white/[0.08] hover:text-white hover:border-white/20'
                            }`}
                        >
                          {m.icon ? `${m.icon} ` : ''}{m.name}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-3">
                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          if ((input.trim() || attachedImages.length > 0) && !submitting) {
                            handleSubmit(e as unknown as React.FormEvent)
                          }
                        }
                      }}
                      onPaste={(e) => {
                        const items = Array.from(e.clipboardData?.items || [])
                        const imageFiles = items
                          .filter((item) => item.type.startsWith('image/'))
                          .map((item) => item.getAsFile())
                          .filter((f): f is File => f !== null)
                        if (imageFiles.length > 0) {
                          e.preventDefault()
                          addImages(imageFiles)
                        }
                      }}
                      placeholder={voice.isListening ? 'Listening...' : attachedImages.length > 0 ? 'Add a message or just send the image(s)...' : 'e.g., Build a REST API for user authentication...'}
                      disabled={submitting}
                      rows={1}
                      className="flex-1 bg-white/[0.03] border border-white/[0.08] rounded-lg px-4 py-3 text-sm text-white
                                 placeholder:text-gray-600 focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20
                                 disabled:opacity-50 transition-all resize-none overflow-hidden"
                      style={{ minHeight: '44px', maxHeight: '160px', height: 'auto' }}
                      onInput={(e) => {
                        const target = e.target as HTMLTextAreaElement
                        target.style.height = 'auto'
                        target.style.height = `${Math.min(target.scrollHeight, 160)}px`
                      }}
                    />
                    {/* Image attach button */}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={submitting || attachedImages.length >= MAX_IMAGES}
                      title={attachedImages.length >= MAX_IMAGES ? `Max ${MAX_IMAGES} images` : 'Attach image(s)'}
                      className="flex items-center justify-center w-11 rounded-lg border transition-all
                        bg-white/[0.03] border-white/[0.08] text-gray-400 hover:text-white hover:border-white/20
                        disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <Paperclip className="w-4 h-4" />
                    </button>
                    {/* Mic toggle */}
                    {voice.canListen && (
                      <button
                        type="button"
                        onClick={voice.toggleListening}
                        disabled={submitting}
                        title={voice.isListening ? 'Stop listening' : 'Voice input'}
                        className={`flex items-center justify-center w-11 rounded-lg border transition-all
                          ${voice.isListening
                            ? 'bg-red-500/20 border-red-500/40 text-red-400 animate-pulse'
                            : 'bg-white/[0.03] border-white/[0.08] text-gray-400 hover:text-white hover:border-white/20'
                          } disabled:opacity-30 disabled:cursor-not-allowed`}
                      >
                        {voice.isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={(!input.trim() && attachedImages.length === 0) || submitting}
                      className="flex items-center gap-2 px-5 py-3 rounded-lg bg-accent text-white text-sm font-medium
                                 hover:bg-accent/90 disabled:opacity-30 disabled:cursor-not-allowed
                                 transition-all active:scale-[0.98]"
                    >
                      {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      Submit
                    </button>
                  </div>

                  {/* Drop zone hint */}
                  <p className="text-[10px] text-gray-600 mt-2 text-center">
                    Paste, drag & drop, or click <Paperclip className="w-3 h-3 inline" /> to attach images
                  </p>
                </form>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Task Card ───

function TaskCard({ task, onCancel, onFollowupResponse, onApprovalResponse }: { task: LiveTask; onCancel: (id: string) => void; onFollowupResponse: (questionId: string, response: string) => void; onApprovalResponse: (approvalId: string, approved: boolean, feedback?: string, reason?: string) => void }) {
  const isActive = task.status === 'queued' || task.status === 'planning' || task.status === 'executing'
  const [expanded, setExpanded] = useState(isActive)
  const [followupInput, setFollowupInput] = useState('')

  return (
    <div className={`glass-card p-4 ${isActive ? 'border border-accent/20' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <StatusIcon status={task.status} />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white leading-relaxed font-medium">{task.prompt}</p>

            {isActive && task.currentStep && (
              <p className="text-[11px] text-accent/80 mt-1.5 animate-pulse">{task.currentStep}</p>
            )}

            {/* Task list progress checklist */}
            {task.taskList && task.taskList.length > 0 && (
              <div className="mt-2.5 space-y-1">
                {task.taskList.map((item) => (
                  <div key={item.id} className="flex items-center gap-2">
                    <TaskItemIcon status={item.status} />
                    <span className={`text-[11px] leading-relaxed ${
                      item.status === 'completed' ? 'text-gray-500 line-through' :
                      item.status === 'in-progress' ? 'text-accent' :
                      item.status === 'failed' ? 'text-red-400' :
                      'text-gray-400'
                    }`}>
                      {item.title}
                    </span>
                    <span className="text-[9px] text-gray-600 ml-auto">{item.agent}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Context usage indicator */}
            {isActive && task.contextUsage && (
              <div className="mt-2">
                <ContextIndicator data={task.contextUsage} />
              </div>
            )}

            {task.activityLog.length > 0 && (
              <div className="mt-2">
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
                >
                  <span className="text-[9px]">{expanded ? '▾' : '▸'}</span>
                  {task.activityLog.length} step{task.activityLog.length !== 1 ? 's' : ''}
                </button>
                {expanded && (
                  <div className="mt-1.5 space-y-px ml-1">
                    {task.activityLog.map((step, i) => {
                      const checkpoint = task.checkpoints?.find((c) => c.step === i + 1)
                      // Try to find a matching ToolCallCard for this step index
                      const toolCall = task.toolCalls?.[i]
                      return (
                        <div key={i}>
                          {toolCall
                            ? <ToolCallCard data={toolCall} index={i} />
                            : <StepEntry step={step} index={i} />
                          }
                          {checkpoint && (
                            <CheckpointMarker
                              checkpoint={checkpoint}
                              taskId={task.id}
                              isActive={task.status === 'executing' || task.status === 'planning'}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {task.error && (
              <p className="text-[11px] text-red-400/80 mt-1.5">{task.error}</p>
            )}

            {/* Live streaming text — shows LLM response as it generates */}
            {isActive && task.streamingText && (
              <div className="mt-3">
                <StreamingContent text={task.streamingText} />
              </div>
            )}

            {/* Agent follow-up question */}
            {task.followupQuestion && (
              <div className="mt-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
                <p className="text-sm text-amber-300 font-medium mb-2">
                  💬 {task.followupQuestion.question}
                </p>
                {task.followupQuestion.options && task.followupQuestion.options.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {task.followupQuestion.options.map((opt, i) => (
                      <button
                        key={i}
                        onClick={() => onFollowupResponse(task.followupQuestion!.questionId, opt)}
                        className="px-3 py-1.5 text-xs rounded-md bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 border border-amber-500/20 transition-colors"
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={followupInput}
                    onChange={(e) => setFollowupInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && followupInput.trim()) {
                        onFollowupResponse(task.followupQuestion!.questionId, followupInput.trim())
                        setFollowupInput('')
                      }
                    }}
                    placeholder="Type your answer..."
                    className="flex-1 px-3 py-1.5 text-xs rounded-md bg-white/[0.04] border border-white/[0.08] text-white placeholder:text-gray-500 focus:outline-none focus:border-amber-500/40"
                  />
                  <button
                    onClick={() => {
                      if (followupInput.trim()) {
                        onFollowupResponse(task.followupQuestion!.questionId, followupInput.trim())
                        setFollowupInput('')
                      }
                    }}
                    disabled={!followupInput.trim()}
                    className="px-3 py-1.5 text-xs rounded-md bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 disabled:opacity-40 transition-colors"
                  >
                    <Send className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}

            {/* Tool approval request */}
            {task.approvalRequest && (
              <ApprovalPrompt
                request={task.approvalRequest}
                onRespond={onApprovalResponse}
              />
            )}

            {task.status === 'completed' && task.result && (
              <div className="mt-3">
                {typeof task.result === 'string'
                  ? <Markdown content={task.result} />
                  : <Markdown content={JSON.stringify(task.result, null, 2)} />
                }
                {/* Read aloud button */}
                {'speechSynthesis' in window && (
                  <SpeakButton text={typeof task.result === 'string' ? task.result : JSON.stringify(task.result)} />
                )}
              </div>
            )}

            <div className="flex items-center gap-3 mt-2 text-[10px] text-gray-600">
              <span className="capitalize">{task.status.replace('_', ' ')}</span>
              <span>{new Date(task.timestamp).toLocaleTimeString()}</span>
              {isActive && task.progress !== undefined && task.progress > 0 && (
                <span>{task.progress}%</span>
              )}
            </div>
          </div>
        </div>

        {isActive && (
          <button
            onClick={() => onCancel(task.id)}
            className="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0"
            title="Cancel task"
          >
            <Ban className="w-4 h-4" />
          </button>
        )}
      </div>

      {isActive && task.progress !== undefined && task.progress > 0 && (
        <div className="mt-3 h-1 bg-white/[0.04] rounded-full overflow-hidden">
          <div
            className="h-full bg-accent/60 rounded-full transition-all duration-500"
            style={{ width: `${task.progress}%` }}
          />
        </div>
      )}
    </div>
  )
}

// ─── Step Entry (activity log row) ───

function StepEntry({ step, index }: { step: string; index: number }) {
  const isSuccess = step.startsWith('✓')
  const isFail = step.startsWith('✗')
  const isPlanning = step.startsWith('Planning:') || step.startsWith('Analyzing')
  const isWarning = step.includes('⚠')
  const isReasoning = step.startsWith('💭')

  const color = isReasoning
    ? 'text-gray-400 italic'
    : isFail
      ? 'text-red-400/70'
      : isWarning
        ? 'text-amber-400/70'
        : isPlanning
          ? 'text-blue-400/60'
          : isSuccess
            ? 'text-gray-400'
            : 'text-gray-500'

  // Clean up the step text — remove leading icon since we render our own
  const text = step.replace(/^[✓✗⚠💭]\s*/, '')
  const icon = isReasoning ? '💭' : isFail ? '✗' : isWarning ? '⚠' : isPlanning ? '◆' : '✓'

  return (
    <div className="flex items-start gap-1.5 py-0.5 group">
      <span className={`text-[10px] font-mono ${color} flex-shrink-0 mt-px w-4 text-right opacity-40`}>
        {index + 1}
      </span>
      <span className={`text-[10px] flex-shrink-0 mt-px ${color}`}>
        {icon}
      </span>
      <span className={`text-[10px] leading-relaxed ${color}`}>{text}</span>
    </div>
  )
}

function CheckpointMarker({ checkpoint, taskId, isActive }: { checkpoint: CheckpointInfo; taskId: string; isActive: boolean }) {
  const [rolling, setRolling] = useState(false)

  const handleRollback = async () => {
    if (rolling || isActive) return
    setRolling(true)
    try {
      await window.brainwave.rollbackToCheckpoint(taskId, checkpoint.id)
    } catch (err) {
      console.error('[CommandCenter] Rollback failed:', err)
    } finally {
      setRolling(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5 py-0.5 ml-5">
      <span className="text-[10px] text-cyan-400/70">📌</span>
      <span className="text-[9px] text-cyan-400/60 truncate max-w-[180px]">
        {checkpoint.description || `Checkpoint after ${checkpoint.tool}`}
      </span>
      {!isActive && (
        <button
          onClick={handleRollback}
          disabled={rolling}
          title="Rollback to this checkpoint"
          className="ml-auto text-gray-600 hover:text-amber-400 transition-colors disabled:opacity-30"
        >
          {rolling
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <Undo2 className="w-3 h-3" />
          }
        </button>
      )}
    </div>
  )
}

function StatusIcon({ status }: { status: TaskStatus }) {
  switch (status) {
    case 'queued':
      return <Clock className="w-4 h-4 text-gray-500 flex-shrink-0 mt-0.5" />
    case 'planning':
      return <Loader2 className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5 animate-spin" />
    case 'executing':
      return <Loader2 className="w-4 h-4 text-accent flex-shrink-0 mt-0.5 animate-spin" />
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
    case 'failed':
      return <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
    case 'cancelled':
      return <XCircle className="w-4 h-4 text-gray-500 flex-shrink-0 mt-0.5" />
    default:
      return <Clock className="w-4 h-4 text-gray-500 flex-shrink-0 mt-0.5" />
  }
}

function TaskItemIcon({ status }: { status: TaskListItemStatus }) {
  switch (status) {
    case 'in-progress':
      return <Loader2 className="w-3 h-3 text-accent flex-shrink-0 animate-spin" />
    case 'completed':
      return <CheckCircle2 className="w-3 h-3 text-green-400 flex-shrink-0" />
    case 'failed':
      return <XCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
    default:
      return <div className="w-3 h-3 rounded-full border border-gray-600 flex-shrink-0" />
  }
}

// ─── Speak Button (TTS) ───

function SpeakButton({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false)

  const toggle = useCallback(() => {
    if (speaking) {
      speechSynthesis.cancel()
      setSpeaking(false)
      return
    }
    // Strip markdown formatting for cleaner speech
    const clean = text
      .replace(/```[\s\S]*?```/g, ' code block ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[#*_~>\-|[\]()]/g, '')
      .replace(/\n+/g, '. ')
      .replace(/\s+/g, ' ')
      .trim()

    const utterance = new SpeechSynthesisUtterance(clean)
    utterance.rate = 1.0
    utterance.onend = () => setSpeaking(false)
    utterance.onerror = () => setSpeaking(false)
    setSpeaking(true)
    speechSynthesis.speak(utterance)
  }, [speaking, text])

  // Cleanup on unmount
  useEffect(() => {
    return () => { if (speaking) speechSynthesis.cancel() }
  }, [speaking])

  return (
    <button
      onClick={toggle}
      className="mt-2 flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
      title={speaking ? 'Stop reading' : 'Read aloud'}
    >
      {speaking ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
      {speaking ? 'Stop' : 'Read aloud'}
    </button>
  )
}

// ─── Approval Prompt ───

const SAFETY_COLORS: Record<string, { border: string; bg: string; text: string; label: string }> = {
  safe: { border: 'border-green-500/30', bg: 'bg-green-500/5', text: 'text-green-300', label: 'Read' },
  write: { border: 'border-blue-500/30', bg: 'bg-blue-500/5', text: 'text-blue-300', label: 'Write' },
  execute: { border: 'border-orange-500/30', bg: 'bg-orange-500/5', text: 'text-orange-300', label: 'Execute' },
  dangerous: { border: 'border-red-500/30', bg: 'bg-red-500/5', text: 'text-red-300', label: 'Dangerous' },
}

function ApprovalPrompt({ request, onRespond }: {
  request: ApprovalRequest
  onRespond: (approvalId: string, approved: boolean, feedback?: string, reason?: string) => void
}) {
  const [rejectReason, setRejectReason] = useState('')
  const [showRejectInput, setShowRejectInput] = useState(false)
  const safety = SAFETY_COLORS[request.safetyLevel] ?? SAFETY_COLORS.execute

  return (
    <div className={`mt-3 p-3 rounded-lg border ${safety.border} ${safety.bg}`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck className={`w-4 h-4 ${safety.text}`} />
        <span className={`text-xs font-semibold ${safety.text} uppercase`}>{safety.label} — Approval Required</span>
      </div>

      {/* Summary */}
      <p className="text-sm text-white/90 font-medium mb-1">{request.summary}</p>

      {/* Tool + args detail */}
      <div className="text-[11px] text-gray-400 mb-2">
        <span className="font-mono">{request.tool}</span>
        {request.args && Object.keys(request.args).length > 0 && (
          <pre className="mt-1 p-2 rounded bg-black/30 text-gray-400 overflow-x-auto max-h-32 text-[10px]">
            {JSON.stringify(request.args, null, 2)}
          </pre>
        )}
      </div>

      {/* Diff preview for file edits */}
      {request.diffPreview && (
        <details className="mb-2">
          <summary className="text-[11px] text-gray-400 cursor-pointer hover:text-gray-300">Show diff preview</summary>
          <pre className="mt-1 p-2 rounded bg-black/30 text-[10px] overflow-x-auto max-h-48 text-gray-300">
            {request.diffPreview}
          </pre>
        </details>
      )}

      {/* Reject reason input */}
      {showRejectInput && (
        <div className="mb-2">
          <input
            type="text"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRespond(request.approvalId, false, undefined, rejectReason.trim() || undefined)
              }
            }}
            placeholder="Reason for rejection (optional)..."
            className="w-full px-3 py-1.5 text-xs rounded-md bg-white/[0.04] border border-white/[0.08] text-white placeholder:text-gray-500 focus:outline-none focus:border-red-500/40"
            autoFocus
          />
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => onRespond(request.approvalId, true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-green-500/20 text-green-300 hover:bg-green-500/30 border border-green-500/20 transition-colors"
        >
          <ShieldCheck className="w-3 h-3" />
          Approve
        </button>
        {showRejectInput ? (
          <button
            onClick={() => onRespond(request.approvalId, false, undefined, rejectReason.trim() || undefined)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/20 transition-colors"
          >
            <ShieldX className="w-3 h-3" />
            Confirm Reject
          </button>
        ) : (
          <button
            onClick={() => setShowRejectInput(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors"
          >
            <ShieldX className="w-3 h-3" />
            Reject
          </button>
        )}
      </div>
    </div>
  )
}
