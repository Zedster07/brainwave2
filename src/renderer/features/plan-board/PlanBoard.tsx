import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Clock, Lightbulb, Play, CheckCircle2,
  AlertTriangle, XCircle, RefreshCw, Search, Filter, ChevronDown,
  ChevronUp, Ban, History, Zap, MessageSquare
} from 'lucide-react'
import type { TaskRecord } from '@shared/types'

// ─── Column Configuration ───────────────────────────────

interface Column {
  key: string
  label: string
  statuses: string[] // Both TaskStatus and TaskRecord.status values
  color: string
  icon: typeof Clock
}

const COLUMNS: Column[] = [
  { key: 'queued', label: 'Queued', statuses: ['queued', 'pending'], color: 'text-gray-400', icon: Clock },
  { key: 'planning', label: 'Planning', statuses: ['planning'], color: 'text-blue-400', icon: Lightbulb },
  { key: 'executing', label: 'Executing', statuses: ['executing', 'in_progress'], color: 'text-amber-400', icon: Play },
  { key: 'done', label: 'Done', statuses: ['completed', 'failed', 'cancelled'], color: 'text-green-400', icon: CheckCircle2 },
]

// ─── Plan Board ─────────────────────────────────────────

export function PlanBoard() {
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [historyTasks, setHistoryTasks] = useState<TaskRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [showHistory, setShowHistory] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [priorityFilter, setPriorityFilter] = useState<string | null>(null)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)

  const loadTasks = useCallback(async () => {
    try {
      setLoading(true)
      const [active, history] = await Promise.all([
        window.brainwave.getActiveTasks(),
        window.brainwave.getTaskHistory(50),
      ])
      setTasks(active)
      setHistoryTasks(history)
    } catch (err) {
      console.error('Failed to load tasks:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTasks()
  }, [loadTasks])

  // Subscribe to task updates for live column changes
  useEffect(() => {
    const unsubscribe = window.brainwave.onTaskUpdate((update) => {
      setTasks((prev) => {
        const existing = prev.find((t) => t.id === update.taskId)
        if (existing) {
          return prev.map((t) =>
            t.id === update.taskId
              ? {
                  ...t,
                  status: update.status as TaskRecord['status'],
                  result: update.result ?? t.result,
                  error: update.error ?? t.error,
                  completedAt: (update.status === 'completed' || update.status === 'failed')
                    ? Date.now()
                    : t.completedAt,
                }
              : t
          )
        }
        return [
          ...prev,
          {
            id: update.taskId,
            prompt: update.currentStep || 'Unknown task',
            priority: 'normal' as const,
            status: update.status as TaskRecord['status'],
            result: update.result,
            error: update.error,
            createdAt: Date.now(),
          },
        ]
      })
    })
    return unsubscribe
  }, [])

  // Merge active + history if showing history, deduplicating by ID
  const allTasks = useMemo(() => {
    if (!showHistory) return tasks
    const seen = new Set(tasks.map((t) => t.id))
    const merged = [...tasks]
    for (const ht of historyTasks) {
      if (!seen.has(ht.id)) {
        merged.push(ht)
        seen.add(ht.id)
      }
    }
    return merged
  }, [tasks, historyTasks, showHistory])

  // Apply filters
  const filteredTasks = useMemo(() => {
    let result = allTasks
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter((t) => t.prompt.toLowerCase().includes(q))
    }
    if (priorityFilter) {
      result = result.filter((t) => t.priority === priorityFilter)
    }
    return result
  }, [allTasks, searchQuery, priorityFilter])

  const getColumnTasks = (col: Column) =>
    filteredTasks.filter((t) => col.statuses.includes(t.status))

  const handleCancel = async (taskId: string) => {
    try {
      await window.brainwave.cancelTask(taskId)
    } catch (err) {
      console.error('Failed to cancel task:', err)
    }
  }

  const totalActive = tasks.filter(
    (t) => !['completed', 'failed', 'cancelled'].includes(t.status)
  ).length

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <LayoutDashboard className="w-5 h-5 text-agent-planner" />
        <h2 className="text-lg font-semibold text-white">Plan Board</h2>
        <span className="text-xs text-gray-500 bg-white/[0.04] px-2 py-0.5 rounded-full">
          {totalActive} active
        </span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Search */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            placeholder="Filter tasks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="bg-white/[0.04] border border-white/[0.06] rounded-md pl-7 pr-3 py-1.5 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-accent/40 w-40 transition-colors"
          />
        </div>

        {/* Priority filter */}
        <div className="flex items-center gap-1">
          <Filter className="w-3.5 h-3.5 text-gray-500" />
          {['high', 'normal', 'low'].map((p) => (
            <button
              key={p}
              onClick={() => setPriorityFilter(priorityFilter === p ? null : p)}
              className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${
                priorityFilter === p
                  ? p === 'high' ? 'bg-orange-500/30 text-orange-400' :
                    p === 'low' ? 'bg-gray-500/30 text-gray-400' :
                    'bg-accent/20 text-accent'
                  : 'bg-white/[0.04] text-gray-500 hover:bg-white/[0.06]'
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        {/* History toggle */}
        <button
          onClick={() => setShowHistory(!showHistory)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
            showHistory
              ? 'bg-accent/10 text-accent border border-accent/20'
              : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'
          }`}
          title="Show task history"
        >
          <History className="w-3.5 h-3.5" />
          History
        </button>

        {/* Refresh */}
        <button
          onClick={loadTasks}
          className="p-1.5 rounded-md hover:bg-white/[0.04] text-gray-500 hover:text-gray-300 transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Kanban Columns */}
      <div className="grid grid-cols-4 gap-4 flex-1 min-h-0">
        {COLUMNS.map((col) => {
          const colTasks = getColumnTasks(col)
          const ColIcon = col.icon

          return (
            <div key={col.key} className="flex flex-col min-h-0">
              {/* Column header */}
              <div className="flex items-center gap-2 mb-3">
                <ColIcon className={`w-3.5 h-3.5 ${col.color}`} />
                <h3 className={`text-sm font-medium ${col.color}`}>{col.label}</h3>
                <span className="text-[10px] text-gray-600 bg-white/[0.04] px-1.5 py-0.5 rounded">
                  {colTasks.length}
                </span>
              </div>

              {/* Column body */}
              <div className="glass-card p-3 flex-1 overflow-y-auto min-h-[200px] space-y-2">
                {colTasks.length === 0 ? (
                  <EmptyColumn columnKey={col.key} />
                ) : (
                  colTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      expanded={expandedTaskId === task.id}
                      onToggle={() => setExpandedTaskId(
                        expandedTaskId === task.id ? null : task.id
                      )}
                      onCancel={handleCancel}
                      onViewInChat={task.sessionId ? () => navigate(`/?session=${task.sessionId}`) : undefined}
                    />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Empty Column State ─────────────────────────────────

function EmptyColumn({ columnKey }: { columnKey: string }) {
  const messages: Record<string, { text: string; hint: string }> = {
    queued: { text: 'No queued tasks', hint: 'Submit a task from the Command Center' },
    planning: { text: 'Nothing planning', hint: 'Tasks appear here when the Planner is decomposing them' },
    executing: { text: 'Nothing running', hint: 'Agents work here when executing sub-tasks' },
    done: { text: 'No completed tasks', hint: 'Enable History to see past results' },
  }
  const msg = messages[columnKey] ?? { text: 'Empty', hint: '' }

  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <p className="text-xs text-gray-600 mb-1">{msg.text}</p>
      <p className="text-[10px] text-gray-700">{msg.hint}</p>
    </div>
  )
}

// ─── Task Card ──────────────────────────────────────────

interface TaskCardProps {
  task: TaskRecord
  expanded: boolean
  onToggle: () => void
  onCancel: (id: string) => void
  onViewInChat?: () => void
}

function TaskCard({ task, expanded, onToggle, onCancel, onViewInChat }: TaskCardProps) {
  const StatusIcon =
    task.status === 'pending' ? Clock :
    task.status === 'planning' ? Lightbulb :
    task.status === 'in_progress' ? Play :
    task.status === 'completed' ? CheckCircle2 :
    task.status === 'failed' ? AlertTriangle :
    task.status === 'cancelled' ? XCircle :
    Clock

  const statusColor =
    task.status === 'pending' ? 'text-gray-400' :
    task.status === 'planning' ? 'text-blue-400' :
    task.status === 'in_progress' ? 'text-amber-400' :
    task.status === 'completed' ? 'text-green-400' :
    task.status === 'failed' ? 'text-red-400' :
    'text-gray-500'

  const priorityBadge =
    task.priority === 'high' ? 'bg-orange-500/20 text-orange-400' :
    task.priority === 'low' ? 'bg-gray-500/20 text-gray-400' :
    'bg-accent/10 text-accent'

  const isActive = ['pending', 'planning', 'in_progress'].includes(task.status)
  const isExecuting = task.status === 'in_progress'

  return (
    <div
      className={`bg-white/[0.02] border rounded-lg transition-all duration-200 cursor-pointer ${
        expanded
          ? 'border-accent/20 bg-white/[0.04]'
          : 'border-white/[0.04] hover:border-white/[0.08]'
      } ${isExecuting ? 'ring-1 ring-amber-500/20' : ''}`}
      onClick={onToggle}
    >
      {/* Compact view — always visible */}
      <div className="p-3">
        <div className="flex items-start gap-2 mb-2">
          <StatusIcon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${statusColor} ${isExecuting ? 'animate-pulse' : ''}`} />
          <p className={`text-xs text-gray-300 flex-1 ${expanded ? '' : 'line-clamp-2'}`}>
            {task.prompt}
          </p>
          {expanded
            ? <ChevronUp className="w-3 h-3 text-gray-600 flex-shrink-0 mt-0.5" />
            : <ChevronDown className="w-3 h-3 text-gray-600 flex-shrink-0 mt-0.5" />
          }
        </div>

        <div className="flex items-center gap-2">
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${priorityBadge}`}>
            {task.priority}
          </span>
          {isExecuting && (
            <span className="flex items-center gap-1 text-[9px] text-amber-400/80">
              <Zap className="w-2.5 h-2.5" />
              Running
            </span>
          )}
          <span className="text-[9px] text-gray-600 ml-auto">
            {formatTime(task.createdAt)}
          </span>
        </div>
      </div>

      {/* Expanded detail view */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-white/[0.04] mt-0 pt-2 space-y-2" onClick={(e) => e.stopPropagation()}>
          {/* Status line */}
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-gray-500">Status:</span>
            <span className={statusColor}>{task.status}</span>
            {task.completedAt && (
              <>
                <span className="text-gray-600">•</span>
                <span className="text-gray-500">
                  Completed {formatTime(task.completedAt)}
                </span>
              </>
            )}
          </div>

          {/* Duration */}
          {task.completedAt && (
            <div className="text-[10px] text-gray-500">
              Duration: {formatDuration(task.completedAt - task.createdAt)}
            </div>
          )}

          {/* Error */}
          {task.error && (
            <div className="bg-red-500/5 border border-red-500/10 rounded-md p-2">
              <p className="text-[10px] text-red-400/80">{task.error}</p>
            </div>
          )}

          {/* Result preview */}
          {task.result && (
            <div className="bg-white/[0.02] border border-white/[0.04] rounded-md p-2 max-h-32 overflow-y-auto">
              <p className="text-[10px] text-gray-400 whitespace-pre-wrap">
                {typeof task.result === 'string'
                  ? task.result.slice(0, 500)
                  : JSON.stringify(task.result, null, 2).slice(0, 500)}
                {(typeof task.result === 'string' ? task.result : JSON.stringify(task.result)).length > 500 && '...'}
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            {onViewInChat && (
              <button
                onClick={onViewInChat}
                className="flex items-center gap-1 text-[10px] text-accent/70 hover:text-accent px-2 py-1 rounded hover:bg-accent/10 transition-colors"
              >
                <MessageSquare className="w-3 h-3" />
                View in Chat
              </button>
            )}
            {isActive && (
              <button
                onClick={() => onCancel(task.id)}
                className="flex items-center gap-1 text-[10px] text-red-400/70 hover:text-red-400 px-2 py-1 rounded hover:bg-red-500/10 transition-colors"
              >
                <Ban className="w-3 h-3" />
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  return `${mins}m ${remSecs}s`
}