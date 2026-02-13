import { useState, useEffect, useCallback, useRef } from 'react'
import { Send, Sparkles, Clock, CheckCircle2, XCircle, Loader2, AlertTriangle, Ban, Plus, MessageSquare, Trash2, Pencil, PanelLeftClose, PanelLeft } from 'lucide-react'
import { Markdown } from '../../components/Markdown'
import type { TaskUpdate, TaskStatus, ChatSession } from '@shared/types'

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
}

export function CommandCenter() {
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [tasks, setTasks] = useState<LiveTask[]>([])
  const [loaded, setLoaded] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when tasks change
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    })
  }, [])

  // Session state
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  // Load sessions on mount
  useEffect(() => {
    window.brainwave.listSessions().then((list) => {
      setSessions(list)
      // Auto-select the most recent session if any
      if (list.length > 0) {
        setActiveSessionId(list[0].id)
      }
    }).catch(console.error)
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
    window.brainwave.getSessionTasks(activeSessionId, 50).then((history) => {
      setTasks(
        history.reverse().map((h) => ({
          id: h.id,
          prompt: h.prompt,
          status: h.status,
          result: h.result,
          error: h.error,
          activityLog: [] as string[],
          timestamp: h.createdAt,
        }))
      )
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
            return {
              ...t,
              status: update.status,
              currentStep: update.currentStep,
              progress: update.progress,
              result: update.result ?? t.result,
              error: update.error ?? t.error,
              activityLog,
              timestamp: update.timestamp,
            }
          })
        }
        return prev
      })
    })
    return unsubscribe
  }, [])

  const handleNewChat = useCallback(async () => {
    // Create a new session immediately, switch to it
    try {
      const session = await window.brainwave.createSession('New Chat')
      setSessions((prev) => [session, ...prev])
      setActiveSessionId(session.id)
      setTasks([])
      inputRef.current?.focus()
    } catch (err) {
      console.error('[CommandCenter] Failed to create session:', err)
    }
  }, [])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || submitting) return

    const prompt = input.trim()
    setInput('')
    setSubmitting(true)

    try {
      // Auto-create session if none active
      let sessionId = activeSessionId
      if (!sessionId) {
        const session = await window.brainwave.createSession(prompt.slice(0, 60))
        setSessions((prev) => [session, ...prev])
        setActiveSessionId(session.id)
        sessionId = session.id
      } else {
        // Auto-title: if this is the first message in the session, update title
        if (tasks.length === 0) {
          const title = prompt.slice(0, 60)
          const updated = await window.brainwave.renameSession(sessionId, title)
          if (updated) {
            setSessions((prev) => prev.map((s) => s.id === sessionId ? { ...s, title: updated.title } : s))
          }
        }
      }

      const { taskId } = await window.brainwave.submitTask({
        id: crypto.randomUUID(),
        prompt,
        priority: 'normal',
        sessionId,
      })

      setTasks((prev) => [
        ...prev,
        { id: taskId, prompt, status: 'queued', activityLog: [], timestamp: Date.now() },
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
  }, [input, submitting, activeSessionId, tasks.length])

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
      }
    } catch (err) {
      console.error('[CommandCenter] Failed to rename session:', err)
    }
    setEditingSessionId(null)
  }, [])

  const activeSession = sessions.find((s) => s.id === activeSessionId)

  return (
    <div className="flex h-full">
      {/* Session Sidebar */}
      {sidebarOpen && (
        <div className="w-64 flex-shrink-0 border-r border-white/[0.06] flex flex-col bg-white/[0.01]">
          {/* Sidebar Header */}
          <div className="p-3 flex items-center justify-between border-b border-white/[0.06]">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Chats</span>
            <div className="flex items-center gap-1">
              <button
                onClick={handleNewChat}
                className="p-1.5 rounded-md hover:bg-white/[0.06] text-gray-400 hover:text-white transition-colors"
                title="New Chat"
              >
                <Plus className="w-4 h-4" />
              </button>
              <button
                onClick={() => setSidebarOpen(false)}
                className="p-1.5 rounded-md hover:bg-white/[0.06] text-gray-400 hover:text-white transition-colors"
                title="Close sidebar"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Session List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {sessions.length === 0 ? (
              <p className="text-[11px] text-gray-600 text-center py-6">No chats yet</p>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.id}
                  className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors
                    ${activeSessionId === session.id
                      ? 'bg-accent/10 text-white'
                      : 'text-gray-400 hover:bg-white/[0.04] hover:text-gray-200'
                    }`}
                  onClick={() => { setActiveSessionId(session.id); setEditingSessionId(null) }}
                >
                  <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
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
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent/10 mb-4 glow-accent">
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
                  <div className="flex items-center justify-center py-12">
                    <p className="text-sm text-gray-500">Send a message to get started</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {tasks.map((task) => (
                      <TaskCard key={task.id} task={task} onCancel={handleCancel} />
                    ))}
                  </div>
                )}
              </div>

              {/* Task Input — pinned to bottom */}
              <div className="sticky bottom-0 z-10 pt-2 pb-4 px-4 bg-gradient-to-t from-primary via-primary to-transparent">
                <form onSubmit={handleSubmit} className="glass-card p-4">
                  <div className="flex gap-3">
                    <input
                      ref={inputRef}
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder="e.g., Build a REST API for user authentication..."
                      disabled={submitting}
                      className="flex-1 bg-white/[0.03] border border-white/[0.08] rounded-lg px-4 py-3 text-sm text-white
                                 placeholder:text-gray-600 focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20
                                 disabled:opacity-50 transition-all"
                    />
                    <button
                      type="submit"
                      disabled={!input.trim() || submitting}
                      className="flex items-center gap-2 px-5 py-3 rounded-lg bg-accent text-white text-sm font-medium
                                 hover:bg-accent/90 disabled:opacity-30 disabled:cursor-not-allowed
                                 transition-all active:scale-[0.98]"
                    >
                      {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      Submit
                    </button>
                  </div>
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

function TaskCard({ task, onCancel }: { task: LiveTask; onCancel: (id: string) => void }) {
  const isActive = task.status === 'queued' || task.status === 'planning' || task.status === 'executing'
  const [expanded, setExpanded] = useState(isActive)

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

            {task.activityLog.length > 0 && (
              <div className="mt-2">
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                >
                  {expanded ? '▾' : '▸'} {task.activityLog.length} steps
                </button>
                {expanded && (
                  <div className="mt-1 space-y-0.5 border-l border-white/[0.06] pl-2 ml-1">
                    {task.activityLog.map((step, i) => (
                      <p key={i} className="text-[11px] text-gray-500 leading-relaxed">{step}</p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {task.error && (
              <p className="text-[11px] text-red-400/80 mt-1.5">{task.error}</p>
            )}

            {task.status === 'completed' && task.result && (
              <div className="mt-3">
                {typeof task.result === 'string'
                  ? <Markdown content={task.result} />
                  : <Markdown content={JSON.stringify(task.result, null, 2)} />
                }
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
