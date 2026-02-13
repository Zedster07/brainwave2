import { v4 as uuid } from 'uuid'
import { parseExpression } from 'cron-parser'
import { EventEmitter } from 'events'

// ─── Types ──────────────────────────────────────────────────

export type ScheduleType = 'once' | 'cron' | 'interval'
export type ScheduledJobStatus = 'active' | 'paused' | 'completed' | 'failed'

export interface ScheduledJob {
  id: string
  name: string
  description?: string

  // What to do
  taskPrompt: string                     // Agent task prompt to execute
  taskPriority: 'low' | 'normal' | 'high'
  taskContext?: Record<string, unknown>  // Extra context for the agent

  // When to do it
  type: ScheduleType
  cronExpression?: string                // For type=cron (e.g. "0 9 * * 1-5")
  intervalMs?: number                    // For type=interval (ms between runs)
  runAt?: number                         // For type=once (unix timestamp ms)

  // State
  status: ScheduledJobStatus
  nextRunAt: number | null               // Next scheduled execution (unix ms)
  lastRunAt: number | null               // Last execution time
  lastRunResult?: 'success' | 'failure'
  lastRunError?: string
  runCount: number
  maxRuns?: number                       // Optional limit (null = unlimited)
  createdAt: number
  updatedAt: number
}

export interface CreateJobInput {
  name: string
  description?: string
  taskPrompt: string
  taskPriority?: 'low' | 'normal' | 'high'
  taskContext?: Record<string, unknown>
  type: ScheduleType
  cronExpression?: string
  intervalMs?: number
  runAt?: number
  maxRuns?: number
}

// ─── Scheduler Service ──────────────────────────────────────

export class SchedulerService extends EventEmitter {
  private jobs: Map<string, ScheduledJob> = new Map()
  private timers: Map<string, NodeJS.Timeout> = new Map()
  private tickInterval: NodeJS.Timeout | null = null
  private paused = false

  constructor() {
    super()
  }

  /** Start the scheduler tick loop (checks every 15s) */
  start(): void {
    if (this.tickInterval) return
    console.log('[Scheduler] Started')

    this.tickInterval = setInterval(() => {
      if (!this.paused) this.tick()
    }, 15_000) // Check every 15 seconds

    // Immediate first tick
    if (!this.paused) this.tick()
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval)
      this.tickInterval = null
    }
    // Clear all individual timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    console.log('[Scheduler] Stopped')
  }

  /** Pause all scheduled jobs (keeps state, stops execution) */
  pause(): void {
    this.paused = true
    console.log('[Scheduler] Paused')
    this.emit('scheduler:paused')
  }

  /** Resume the scheduler */
  resume(): void {
    this.paused = false
    console.log('[Scheduler] Resumed')
    this.emit('scheduler:resumed')
    this.tick() // Catch up on anything missed
  }

  /** Create a new scheduled job */
  createJob(input: CreateJobInput): ScheduledJob {
    const now = Date.now()
    const id = uuid()

    const job: ScheduledJob = {
      id,
      name: input.name,
      description: input.description,
      taskPrompt: input.taskPrompt,
      taskPriority: input.taskPriority ?? 'normal',
      taskContext: input.taskContext,
      type: input.type,
      cronExpression: input.cronExpression,
      intervalMs: input.intervalMs,
      runAt: input.runAt,
      status: 'active',
      nextRunAt: this.calculateNextRun(input),
      lastRunAt: null,
      runCount: 0,
      maxRuns: input.maxRuns,
      createdAt: now,
      updatedAt: now,
    }

    this.jobs.set(id, job)
    this.emit('job:created', job)
    console.log(`[Scheduler] Job created: "${job.name}" (${job.type}) → next run: ${job.nextRunAt ? new Date(job.nextRunAt).toISOString() : 'none'}`)

    return job
  }

  /** Update an existing job */
  updateJob(id: string, updates: Partial<CreateJobInput>): ScheduledJob | null {
    const job = this.jobs.get(id)
    if (!job) return null

    if (updates.name !== undefined) job.name = updates.name
    if (updates.description !== undefined) job.description = updates.description
    if (updates.taskPrompt !== undefined) job.taskPrompt = updates.taskPrompt
    if (updates.taskPriority !== undefined) job.taskPriority = updates.taskPriority
    if (updates.taskContext !== undefined) job.taskContext = updates.taskContext
    if (updates.cronExpression !== undefined) job.cronExpression = updates.cronExpression
    if (updates.intervalMs !== undefined) job.intervalMs = updates.intervalMs
    if (updates.runAt !== undefined) job.runAt = updates.runAt
    if (updates.maxRuns !== undefined) job.maxRuns = updates.maxRuns

    // Recalculate next run if schedule changed
    if (updates.cronExpression || updates.intervalMs || updates.runAt || updates.type) {
      if (updates.type) job.type = updates.type
      job.nextRunAt = this.calculateNextRun(job)
    }

    job.updatedAt = Date.now()
    this.emit('job:updated', job)
    return job
  }

  /** Delete a job */
  deleteJob(id: string): boolean {
    const timer = this.timers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    const deleted = this.jobs.delete(id)
    if (deleted) this.emit('job:deleted', { id })
    return deleted
  }

  /** Pause a single job */
  pauseJob(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job) return false
    job.status = 'paused'
    job.updatedAt = Date.now()
    this.emit('job:updated', job)
    return true
  }

  /** Resume a single job */
  resumeJob(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || job.status !== 'paused') return false
    job.status = 'active'
    job.nextRunAt = this.calculateNextRun(job)
    job.updatedAt = Date.now()
    this.emit('job:updated', job)
    return true
  }

  /** Get all jobs */
  getJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values())
  }

  /** Get a single job */
  getJob(id: string): ScheduledJob | null {
    return this.jobs.get(id) ?? null
  }

  /** Manually trigger a job immediately */
  triggerNow(id: string): void {
    const job = this.jobs.get(id)
    if (job) this.executeJob(job)
  }

  // ─── Internal ──────────────────────────────────────────

  /** Main tick — checks all jobs and fires any that are due */
  private tick(): void {
    const now = Date.now()

    for (const job of this.jobs.values()) {
      if (job.status !== 'active') continue
      if (job.nextRunAt === null) continue
      if (job.nextRunAt > now) continue

      // Job is due — execute it
      this.executeJob(job)
    }
  }

  /** Execute a scheduled job */
  private executeJob(job: ScheduledJob): void {
    const now = Date.now()
    job.lastRunAt = now
    job.runCount++
    job.updatedAt = now

    console.log(`[Scheduler] Executing job: "${job.name}" (run #${job.runCount})`)

    // Emit execution event — the main process will handle the actual task submission
    this.emit('job:execute', {
      jobId: job.id,
      taskPrompt: job.taskPrompt,
      taskPriority: job.taskPriority,
      taskContext: {
        ...job.taskContext,
        _scheduledJob: job.id,
        _scheduledRun: job.runCount,
      },
    })

    // Check if job has reached max runs
    if (job.maxRuns && job.runCount >= job.maxRuns) {
      job.status = 'completed'
      job.nextRunAt = null
      console.log(`[Scheduler] Job "${job.name}" completed (${job.runCount}/${job.maxRuns} runs)`)
    } else {
      // Schedule next run
      job.nextRunAt = this.calculateNextRun(job)
    }

    this.emit('job:updated', job)
  }

  /** Calculate the next run time for a job */
  private calculateNextRun(job: Pick<ScheduledJob, 'type' | 'cronExpression' | 'intervalMs' | 'runAt' | 'lastRunAt'>): number | null {
    const now = Date.now()

    switch (job.type) {
      case 'once':
        // One-shot: run at the specified time (or null if already past)
        if (job.runAt && job.runAt > now) return job.runAt
        if (job.runAt && job.runAt <= now && !job.lastRunAt) return now // Due immediately
        return null // Already ran

      case 'cron':
        if (!job.cronExpression) return null
        try {
          const interval = parseExpression(job.cronExpression, { currentDate: new Date() })
          return interval.next().getTime()
        } catch (err) {
          console.error(`[Scheduler] Invalid cron expression: ${job.cronExpression}`, err)
          return null
        }

      case 'interval':
        if (!job.intervalMs) return null
        const base = job.lastRunAt ?? now
        return base + job.intervalMs

      default:
        return null
    }
  }

  // ─── Persistence Helpers ───────────────────────────────

  /** Export all jobs as serializable array (for SQLite persistence) */
  exportJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values())
  }

  /** Import jobs from persisted state (e.g., SQLite on startup) */
  importJobs(jobs: ScheduledJob[]): void {
    for (const job of jobs) {
      // Recalculate next run for active jobs
      if (job.status === 'active') {
        job.nextRunAt = this.calculateNextRun(job)
      }
      this.jobs.set(job.id, job)
    }
    console.log(`[Scheduler] Imported ${jobs.length} jobs`)
  }
}

// Singleton
let schedulerInstance: SchedulerService | null = null

export function getScheduler(): SchedulerService {
  if (!schedulerInstance) {
    schedulerInstance = new SchedulerService()
  }
  return schedulerInstance
}
