import { useState, useEffect, useCallback, useRef } from 'react'
import { Send, Sparkles, Clock, CheckCircle2, XCircle, Loader2, AlertTriangle, Ban } from 'lucide-react'
import { Markdown } from '../../components/Markdown'
import type { TaskUpdate, TaskStatus } from '@shared/types'

interface LiveTask {
  id: string
  prompt: string
  status: TaskStatus
  currentStep?: string
  activityLog: string[]   // accumulated step-by-step history
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

  // Load persisted task history on mount
  useEffect(() => {
    if (loaded) return
    window.brainwave.getTaskHistory(50).then((history) => {
      setTasks((prev) => {
        // Merge: keep live tasks, append historical ones not already present
        const liveIds = new Set(prev.map((t) => t.id))
        const historical = history
          .filter((h) => !liveIds.has(h.id))
          .map((h) => ({
            id: h.id,
            prompt: h.prompt,
            status: h.status,
            result: h.result,
            error: h.error,
            activityLog: [] as string[],
            timestamp: h.createdAt,
          }))
        return [...prev, ...historical]
      })
      setLoaded(true)
    }).catch((err) => {
      console.warn('[CommandCenter] Failed to load history:', err)
      setLoaded(true)
    })
  }, [loaded])

  // Subscribe to real-time task updates
  useEffect(() => {
    const unsubscribe = window.brainwave.onTaskUpdate((update: TaskUpdate) => {
      setTasks((prev) => {
        const existing = prev.find((t) => t.id === update.taskId)
        if (existing) {
          return prev.map((t) => {
            if (t.id !== update.taskId) return t
            // Accumulate steps into activity log
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

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || submitting) return

    const prompt = input.trim()
    setInput('')
    setSubmitting(true)

    try {
      const { taskId } = await window.brainwave.submitTask({
        id: crypto.randomUUID(),
        prompt,
        priority: 'normal',
      })

      setTasks((prev) => [
        { id: taskId, prompt, status: 'queued', activityLog: [], timestamp: Date.now() },
        ...prev,
      ])
    } catch (err) {
      console.error('[CommandCenter] Submit failed:', err)
      // Show inline error
      setTasks((prev) => [
        { id: crypto.randomUUID(), prompt, status: 'failed', activityLog: [], error: err instanceof Error ? err.message : 'Submission failed', timestamp: Date.now() },
        ...prev,
      ])
    } finally {
      setSubmitting(false)
      inputRef.current?.focus()
    }
  }, [input, submitting])

  const handleCancel = useCallback(async (taskId: string) => {
    try {
      await window.brainwave.cancelTask(taskId)
    } catch (err) {
      console.error('[CommandCenter] Cancel failed:', err)
    }
  }, [])

  return (
    <div className="flex flex-col h-full max-w-4xl mx-auto">
      {/* Hero / Welcome */}
      <div className="text-center py-8 flex-shrink-0">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent/10 mb-4 glow-accent">
          <Sparkles className="w-8 h-8 text-accent" />
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">What should I work on?</h2>
        <p className="text-gray-500 text-sm max-w-md mx-auto">
          Describe a task and I'll plan, delegate to specialized agents, and execute it autonomously.
        </p>
      </div>

      {/* Task Activity — scrollable area */}
      <div className="flex-1 overflow-y-auto min-h-0 pb-24">
        <h3 className="text-sm font-semibold text-gray-400 mb-3 flex items-center gap-2">
          <Clock className="w-4 h-4" />
          Tasks
          {tasks.length > 0 && (
            <span className="text-[10px] bg-white/[0.04] px-1.5 py-0.5 rounded-full">{tasks.length}</span>
          )}
        </h3>
        {tasks.length === 0 ? (
          <div className="glass-card p-4 flex items-center gap-3">
            <CheckCircle2 className="w-4 h-4 text-gray-600 flex-shrink-0" />
            <span className="text-sm text-gray-400">No tasks yet — submit your first task above</span>
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
      <div className="sticky bottom-0 z-10 pt-2 pb-4 bg-gradient-to-t from-primary via-primary to-transparent">
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
    </div>
  )
}

// ─── Task Card ───

function TaskCard({ task, onCancel }: { task: LiveTask; onCancel: (id: string) => void }) {
  const isActive = task.status === 'queued' || task.status === 'planning' || task.status === 'executing'
  const [expanded, setExpanded] = useState(isActive) // auto-expand while active

  return (
    <div className={`glass-card p-4 ${isActive ? 'border border-accent/20' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <StatusIcon status={task.status} />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white leading-relaxed font-medium">{task.prompt}</p>

            {/* Live delegation step */}
            {isActive && task.currentStep && (
              <p className="text-[11px] text-accent/80 mt-1.5 animate-pulse">{task.currentStep}</p>
            )}

            {/* Activity log — step-by-step delegation */}
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

            {/* Error message */}
            {task.error && (
              <p className="text-[11px] text-red-400/80 mt-1.5">{task.error}</p>
            )}

            {/* Result */}
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

      {/* Progress bar */}
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
