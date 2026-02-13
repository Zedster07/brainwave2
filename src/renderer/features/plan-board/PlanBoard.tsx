import { useState, useEffect, useCallback } from 'react'
import { LayoutDashboard, GitBranch, Clock, Lightbulb, Play, CheckCircle2, AlertTriangle, XCircle, RefreshCw } from 'lucide-react'
import type { TaskRecord, TaskStatus } from '@shared/types'

interface Column {
  key: string
  label: string
  statuses: TaskStatus[]
  color: string
}

const COLUMNS: Column[] = [
  { key: 'queued', label: 'Queued', statuses: ['queued'], color: 'text-gray-400' },
  { key: 'planning', label: 'Planning', statuses: ['planning'], color: 'text-blue-400' },
  { key: 'executing', label: 'Executing', statuses: ['executing'], color: 'text-amber-400' },
  { key: 'done', label: 'Done', statuses: ['completed', 'failed', 'cancelled'], color: 'text-green-400' },
]

export function PlanBoard() {
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [loading, setLoading] = useState(true)

  const loadTasks = useCallback(async () => {
    try {
      const active = await window.brainwave.getActiveTasks()
      setTasks(active)
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
                  status: update.status,
                  result: update.result ?? t.result,
                  error: update.error ?? t.error,
                  completedAt: (update.status === 'completed' || update.status === 'failed') ? Date.now() : t.completedAt,
                }
              : t
          )
        }
        // New task we haven't seen
        return [
          ...prev,
          {
            id: update.taskId,
            prompt: update.currentStep || 'Unknown task',
            priority: 'normal',
            status: update.status,
            result: update.result,
            error: update.error,
            createdAt: Date.now(),
          },
        ]
      })
    })
    return unsubscribe
  }, [])

  const getColumnTasks = (col: Column) => tasks.filter((t) => col.statuses.includes(t.status))

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 mb-6">
        <LayoutDashboard className="w-5 h-5 text-agent-planner" />
        <h2 className="text-lg font-semibold text-white">Plan Board</h2>
        <span className="text-xs text-gray-500 bg-white/[0.04] px-2 py-0.5 rounded-full">
          {tasks.length} tasks
        </span>
        <button onClick={loadTasks} className="ml-auto p-1.5 rounded-md hover:bg-white/[0.04] text-gray-500 hover:text-gray-300 transition-colors" title="Refresh">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-4 gap-4 flex-1 min-h-0">
        {COLUMNS.map((col) => {
          const colTasks = getColumnTasks(col)
          return (
            <div key={col.key} className="flex flex-col min-h-0">
              <div className="flex items-center gap-2 mb-3">
                <GitBranch className={`w-3.5 h-3.5 ${col.color}`} />
                <h3 className={`text-sm font-medium ${col.color}`}>{col.label}</h3>
                <span className="text-[10px] text-gray-600 bg-white/[0.04] px-1.5 py-0.5 rounded">
                  {colTasks.length}
                </span>
              </div>
              <div className="glass-card p-3 flex-1 overflow-y-auto min-h-[200px] space-y-2">
                {colTasks.length === 0 ? (
                  <p className="text-xs text-gray-600 text-center py-8">No tasks</p>
                ) : (
                  colTasks.map((task) => <TaskCard key={task.id} task={task} />)
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Task Card ───

function TaskCard({ task }: { task: TaskRecord }) {
  const StatusIcon =
    task.status === 'queued' ? Clock :
    task.status === 'planning' ? Lightbulb :
    task.status === 'executing' ? Play :
    task.status === 'completed' ? CheckCircle2 :
    task.status === 'failed' ? AlertTriangle :
    XCircle

  const statusColor =
    task.status === 'queued' ? 'text-gray-400' :
    task.status === 'planning' ? 'text-blue-400' :
    task.status === 'executing' ? 'text-amber-400' :
    task.status === 'completed' ? 'text-green-400' :
    task.status === 'failed' ? 'text-red-400' :
    'text-gray-500'

  const priorityBadge =
    task.priority === 'critical' ? 'bg-red-500/20 text-red-400' :
    task.priority === 'high' ? 'bg-orange-500/20 text-orange-400' :
    task.priority === 'low' ? 'bg-gray-500/20 text-gray-400' :
    'bg-accent/10 text-accent'

  return (
    <div className="bg-white/[0.02] border border-white/[0.04] rounded-lg p-3 hover:border-white/[0.08] transition-colors">
      <div className="flex items-start gap-2 mb-2">
        <StatusIcon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${statusColor}`} />
        <p className="text-xs text-gray-300 line-clamp-2 flex-1">{task.prompt}</p>
      </div>

      <div className="flex items-center gap-2">
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${priorityBadge}`}>
          {task.priority}
        </span>
        <span className="text-[9px] text-gray-600 ml-auto">
          {new Date(task.createdAt).toLocaleTimeString()}
        </span>
      </div>

      {task.error && (
        <p className="text-[10px] text-red-400/70 mt-2 truncate" title={task.error}>{task.error}</p>
      )}
    </div>
  )
}
