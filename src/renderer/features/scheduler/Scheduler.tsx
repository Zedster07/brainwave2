import { useState, useEffect } from 'react'
import {
  Clock,
  Plus,
  Play,
  Pause,
  Trash2,
  RotateCw,
  Timer,
  CalendarClock,
  Zap,
  X,
} from 'lucide-react'
import type { ScheduledJobInfo, CreateScheduledJobInput, ScheduleType } from '@shared/types'

// ─── Cron presets for quick selection ───
const CRON_PRESETS = [
  { label: 'Every minute', cron: '* * * * *' },
  { label: 'Every 5 min', cron: '*/5 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Daily at 9am', cron: '0 9 * * *' },
  { label: 'Weekdays 9am', cron: '0 9 * * 1-5' },
  { label: 'Weekly (Mon)', cron: '0 9 * * 1' },
  { label: 'Monthly (1st)', cron: '0 9 1 * *' },
]

// ─── Interval presets ───
const INTERVAL_PRESETS = [
  { label: '30 seconds', ms: 30_000 },
  { label: '1 minute', ms: 60_000 },
  { label: '5 minutes', ms: 300_000 },
  { label: '15 minutes', ms: 900_000 },
  { label: '1 hour', ms: 3_600_000 },
  { label: '6 hours', ms: 21_600_000 },
]

export function Scheduler() {
  const [jobs, setJobs] = useState<ScheduledJobInfo[]>([])
  const [showCreateModal, setShowCreateModal] = useState(false)

  // Load jobs on mount
  useEffect(() => {
    loadJobs()
    const unsub = window.brainwave.onScheduledJobUpdate((updatedJob) => {
      setJobs((prev) =>
        prev.map((j) => (j.id === updatedJob.id ? updatedJob : j))
      )
    })
    return unsub
  }, [])

  async function loadJobs() {
    const result = await window.brainwave.getScheduledJobs()
    setJobs(result)
  }

  async function handleDelete(id: string) {
    await window.brainwave.deleteScheduledJob(id)
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }

  async function handleTogglePause(job: ScheduledJobInfo) {
    if (job.status === 'paused') {
      await window.brainwave.resumeScheduledJob(job.id)
    } else {
      await window.brainwave.pauseScheduledJob(job.id)
    }
    loadJobs()
  }

  async function handleTrigger(id: string) {
    await window.brainwave.triggerScheduledJob(id)
  }

  async function handleCreate(input: CreateScheduledJobInput) {
    const newJob = await window.brainwave.createScheduledJob(input)
    setJobs((prev) => [...prev, newJob])
    setShowCreateModal(false)
  }

  const activeJobs = jobs.filter((j) => j.status === 'active')
  const pausedJobs = jobs.filter((j) => j.status === 'paused')
  const completedJobs = jobs.filter((j) => j.status === 'completed' || j.status === 'failed')

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Clock className="w-5 h-5 text-agent-scheduler" />
          <h2 className="text-lg font-semibold text-white">Scheduler</h2>
          <span className="text-xs text-gray-500 bg-white/[0.04] px-2 py-0.5 rounded-full">
            {activeJobs.length} active
          </span>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium
                     hover:bg-accent/90 transition-all active:scale-[0.98]"
        >
          <Plus className="w-4 h-4" />
          New Job
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard icon={<Zap className="w-4 h-4 text-status-success" />} label="Active" value={activeJobs.length} />
        <StatCard icon={<Pause className="w-4 h-4 text-status-warning" />} label="Paused" value={pausedJobs.length} />
        <StatCard icon={<RotateCw className="w-4 h-4 text-gray-500" />} label="Total Runs" value={jobs.reduce((sum, j) => sum + j.runCount, 0)} />
      </div>

      {/* Job list */}
      {jobs.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <CalendarClock className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-sm text-gray-500 mb-1">No scheduled jobs yet</p>
          <p className="text-xs text-gray-600">
            Create a job to have Brainwave run tasks automatically on a schedule.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onTogglePause={() => handleTogglePause(job)}
              onTrigger={() => handleTrigger(job.id)}
              onDelete={() => handleDelete(job.id)}
            />
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreateModal && (
        <CreateJobModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="glass-card p-4">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-xs text-gray-400">{label}</span>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
    </div>
  )
}

function JobCard({
  job,
  onTogglePause,
  onTrigger,
  onDelete,
}: {
  job: ScheduledJobInfo
  onTogglePause: () => void
  onTrigger: () => void
  onDelete: () => void
}) {
  const scheduleLabel = getScheduleLabel(job)
  const statusColor = {
    active: 'text-status-success',
    paused: 'text-status-warning',
    completed: 'text-gray-500',
    failed: 'text-status-error',
  }[job.status]

  const TypeIcon = {
    once: Timer,
    cron: CalendarClock,
    interval: RotateCw,
  }[job.type]

  return (
    <div className="glass-card-hover p-4">
      <div className="flex items-start justify-between">
        {/* Left side */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1">
            <TypeIcon className="w-4 h-4 text-agent-scheduler flex-shrink-0" />
            <h3 className="text-sm font-medium text-white truncate">{job.name}</h3>
            <span className={`text-[11px] font-medium capitalize ${statusColor}`}>
              {job.status}
            </span>
          </div>

          <p className="text-xs text-gray-500 ml-7 mb-2 truncate">{job.taskPrompt}</p>

          <div className="flex items-center gap-4 ml-7 text-[11px] text-gray-600">
            <span>{scheduleLabel}</span>
            {job.nextRunAt && (
              <span>Next: {formatRelativeTime(job.nextRunAt)}</span>
            )}
            {job.lastRunAt && (
              <span>Last: {formatRelativeTime(job.lastRunAt)}</span>
            )}
            <span>Runs: {job.runCount}{job.maxRuns ? `/${job.maxRuns}` : ''}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 ml-4">
          {(job.status === 'active' || job.status === 'paused') && (
            <>
              <button
                onClick={onTrigger}
                title="Run now"
                className="p-1.5 rounded-md text-gray-500 hover:text-accent hover:bg-white/[0.04] transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onTogglePause}
                title={job.status === 'paused' ? 'Resume' : 'Pause'}
                className="p-1.5 rounded-md text-gray-500 hover:text-status-warning hover:bg-white/[0.04] transition-colors"
              >
                {job.status === 'paused' ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              </button>
            </>
          )}
          <button
            onClick={onDelete}
            title="Delete"
            className="p-1.5 rounded-md text-gray-500 hover:text-status-error hover:bg-white/[0.04] transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Create Job Modal ────────────────────────────────────────

function CreateJobModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (input: CreateScheduledJobInput) => void
}) {
  const [name, setName] = useState('')
  const [taskPrompt, setTaskPrompt] = useState('')
  const [type, setType] = useState<ScheduleType>('cron')
  const [cronExpression, setCronExpression] = useState('0 9 * * *')
  const [intervalMs, setIntervalMs] = useState(3_600_000)
  const [runAt, setRunAt] = useState('')
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal')
  const [maxRuns, setMaxRuns] = useState<string>('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !taskPrompt.trim()) return

    const input: CreateScheduledJobInput = {
      name: name.trim(),
      taskPrompt: taskPrompt.trim(),
      taskPriority: priority,
      type,
      ...(type === 'cron' && { cronExpression }),
      ...(type === 'interval' && { intervalMs }),
      ...(type === 'once' && runAt && { runAt: new Date(runAt).getTime() }),
      ...(maxRuns && { maxRuns: parseInt(maxRuns) }),
    }

    onCreate(input)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass-card w-[520px] max-h-[85vh] overflow-y-auto p-6 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-semibold text-white">Create Scheduled Job</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Name */}
          <Field label="Job Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Daily code review summary"
              className="input-base"
              required
            />
          </Field>

          {/* Task prompt */}
          <Field label="Task Prompt" description="What should Brainwave do when this job runs?">
            <textarea
              value={taskPrompt}
              onChange={(e) => setTaskPrompt(e.target.value)}
              placeholder="e.g., Review all open PRs in my repos and send me a summary..."
              rows={3}
              className="input-base resize-none"
              required
            />
          </Field>

          {/* Schedule type */}
          <Field label="Schedule Type">
            <div className="flex gap-2">
              {(['cron', 'interval', 'once'] as ScheduleType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`px-4 py-2 rounded-md text-sm transition-all capitalize
                    ${type === t ? 'bg-accent/10 text-accent border border-accent/30' : 'bg-white/[0.03] text-gray-400 border border-white/[0.06] hover:text-gray-200'}`}
                >
                  {t === 'cron' ? 'Cron' : t === 'interval' ? 'Interval' : 'One-time'}
                </button>
              ))}
            </div>
          </Field>

          {/* Cron config */}
          {type === 'cron' && (
            <Field label="Cron Expression">
              <input
                type="text"
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="0 9 * * *"
                className="input-base font-mono"
              />
              <div className="flex flex-wrap gap-1.5 mt-2">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.cron}
                    type="button"
                    onClick={() => setCronExpression(p.cron)}
                    className={`text-[11px] px-2 py-1 rounded-md transition-colors
                      ${cronExpression === p.cron ? 'bg-accent/10 text-accent' : 'bg-white/[0.03] text-gray-500 hover:text-gray-300'}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {/* Interval config */}
          {type === 'interval' && (
            <Field label="Run Every">
              <div className="flex flex-wrap gap-2">
                {INTERVAL_PRESETS.map((p) => (
                  <button
                    key={p.ms}
                    type="button"
                    onClick={() => setIntervalMs(p.ms)}
                    className={`text-xs px-3 py-1.5 rounded-md transition-colors
                      ${intervalMs === p.ms ? 'bg-accent/10 text-accent border border-accent/30' : 'bg-white/[0.03] text-gray-400 border border-white/[0.06] hover:text-gray-200'}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {/* One-time config */}
          {type === 'once' && (
            <Field label="Run At">
              <input
                type="datetime-local"
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
                className="input-base"
              />
            </Field>
          )}

          {/* Priority */}
          <div className="flex gap-4">
            <Field label="Priority" className="flex-1">
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as 'low' | 'normal' | 'high')}
                className="input-base"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </Field>

            <Field label="Max Runs" className="flex-1">
              <input
                type="number"
                value={maxRuns}
                onChange={(e) => setMaxRuns(e.target.value)}
                placeholder="Unlimited"
                min={1}
                className="input-base"
              />
            </Field>
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || !taskPrompt.trim()}
              className="flex items-center gap-2 px-5 py-2 rounded-lg bg-accent text-white text-sm font-medium
                         hover:bg-accent/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              <CalendarClock className="w-4 h-4" />
              Create Job
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Reusable field wrapper ───
function Field({ label, description, className, children }: {
  label: string
  description?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={className}>
      <label className="block text-sm text-white font-medium mb-1.5">{label}</label>
      {description && <p className="text-xs text-gray-500 mb-2">{description}</p>}
      {children}
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────

function getScheduleLabel(job: ScheduledJobInfo): string {
  switch (job.type) {
    case 'cron':
      return `Cron: ${job.cronExpression}`
    case 'interval':
      return `Every ${formatDuration(job.intervalMs ?? 0)}`
    case 'once':
      return job.runAt ? `Once at ${new Date(job.runAt).toLocaleString()}` : 'Once'
    default:
      return job.type
  }
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

function formatRelativeTime(timestamp: number): string {
  const diff = timestamp - Date.now()
  const absDiff = Math.abs(diff)
  const past = diff < 0

  if (absDiff < 60_000) return past ? 'just now' : 'in <1m'
  if (absDiff < 3_600_000) {
    const mins = Math.round(absDiff / 60_000)
    return past ? `${mins}m ago` : `in ${mins}m`
  }
  if (absDiff < 86_400_000) {
    const hours = Math.round(absDiff / 3_600_000)
    return past ? `${hours}h ago` : `in ${hours}h`
  }
  const days = Math.round(absDiff / 86_400_000)
  return past ? `${days}d ago` : `in ${days}d`
}
