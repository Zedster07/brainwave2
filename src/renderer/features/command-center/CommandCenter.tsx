import { useState, useEffect, useCallback, useRef } from 'react'
import { Send, Sparkles, Clock, CheckCircle2, XCircle, Loader2, AlertTriangle, Ban, Plus, MessageSquare, Trash2, Pencil, PanelLeftClose, PanelLeft, Mic, MicOff, Volume2, VolumeX, Paperclip, X, ImageIcon } from 'lucide-react'
import { Markdown } from '../../components/Markdown'
import { useVoice } from '../../hooks/useVoice'
import type { TaskUpdate, TaskStatus, ChatSession, TaskLiveState, ImageAttachment } from '@shared/types'

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
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Voice input/output
  const voice = useVoice({
    onResult: (transcript) => setInput((prev) => (prev ? prev + ' ' : '') + transcript),
  })

  // Image attachments
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
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
                      <TaskCard key={task.id} task={task} onCancel={handleCancel} />
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
