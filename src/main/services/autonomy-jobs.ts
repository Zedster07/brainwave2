/**
 * Autonomy Jobs — Default scheduled jobs that make Brainwave proactive
 *
 * Handles two responsibilities:
 * 1. Scheduler persistence (load/save jobs to SQLite across restarts)
 * 2. Seeding default autonomy cron jobs on first startup
 */
import { getDatabase } from '../db/database'
import { getScheduler, type ScheduledJob, type CreateJobInput } from './scheduler.service'

// ─── Scheduler Persistence ──────────────────────────────────

/** Load previously saved jobs from SQLite into the scheduler */
export function loadScheduledJobs(): void {
  const db = getDatabase()
  const scheduler = getScheduler()

  const rows = db.all<{
    id: string
    name: string
    description: string | null
    schedule_type: string
    schedule_value: string
    handler: string
    payload: string
    status: string
    last_run: string | null
    next_run: string | null
    run_count: number
    max_runs: number | null
    created_at: string
    updated_at: string
    metadata: string
  }>(`SELECT * FROM scheduled_jobs`)

  if (rows.length === 0) return

  const jobs: ScheduledJob[] = rows.map((row) => {
    const payload = JSON.parse(row.payload || '{}')
    const metadata = JSON.parse(row.metadata || '{}')

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      taskPrompt: payload.taskPrompt ?? '',
      taskPriority: (payload.taskPriority || 'normal') as 'low' | 'normal' | 'high',
      taskContext: payload.taskContext,
      type: row.schedule_type as 'cron' | 'interval' | 'once',
      cronExpression: row.schedule_type === 'cron' ? row.schedule_value : undefined,
      intervalMs: row.schedule_type === 'interval' ? parseInt(row.schedule_value, 10) : undefined,
      runAt: row.schedule_type === 'once' ? parseInt(row.schedule_value, 10) : undefined,
      status: row.status as ScheduledJob['status'],
      nextRunAt: row.next_run ? new Date(row.next_run).getTime() : null,
      lastRunAt: row.last_run ? new Date(row.last_run).getTime() : null,
      lastRunResult: metadata.lastRunResult,
      lastRunError: metadata.lastRunError,
      runCount: row.run_count,
      maxRuns: row.max_runs ?? undefined,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    }
  })

  scheduler.importJobs(jobs)
  console.log(`[Autonomy] Loaded ${jobs.length} scheduled jobs from DB`)
}

/** Persist all scheduler jobs to SQLite (called periodically and on changes) */
export function saveScheduledJobs(): void {
  const db = getDatabase()
  const scheduler = getScheduler()
  const jobs = scheduler.exportJobs()

  db.transaction(() => {
    const upsert = db.prepare(
      `INSERT OR REPLACE INTO scheduled_jobs
         (id, name, description, schedule_type, schedule_value, handler, payload, status,
          last_run, next_run, run_count, max_runs, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    for (const job of jobs) {
      // Pack task data into payload JSON
      const payload = JSON.stringify({
        taskPrompt: job.taskPrompt,
        taskPriority: job.taskPriority,
        taskContext: job.taskContext,
      })

      // Pack runtime state into metadata JSON
      const metadata = JSON.stringify({
        lastRunResult: job.lastRunResult,
        lastRunError: job.lastRunError,
      })

      // schedule_value: the cron expression, interval ms, or run-at timestamp
      const scheduleValue = job.cronExpression
        ?? job.intervalMs?.toString()
        ?? job.runAt?.toString()
        ?? ''

      upsert.run(
        job.id,
        job.name,
        job.description ?? null,
        job.type,
        scheduleValue,
        'agent-task',
        payload,
        job.status,
        job.lastRunAt ? new Date(job.lastRunAt).toISOString() : null,
        job.nextRunAt ? new Date(job.nextRunAt).toISOString() : null,
        job.runCount,
        job.maxRuns ?? null,
        new Date(job.createdAt).toISOString(),
        new Date(job.updatedAt).toISOString(),
        metadata,
      )
    }

    // Remove jobs from DB that are no longer in the scheduler
    const jobIds = jobs.map((j) => j.id)
    if (jobIds.length > 0) {
      const placeholders = jobIds.map(() => '?').join(',')
      db.raw().prepare(`DELETE FROM scheduled_jobs WHERE id NOT IN (${placeholders})`).run(...jobIds)
    } else {
      db.run(`DELETE FROM scheduled_jobs`)
    }
  })
}

/** Start auto-save: persist on every job change + periodic backup */
export function startSchedulerPersistence(): void {
  const scheduler = getScheduler()

  // Save on every change event
  scheduler.on('job:created', () => saveScheduledJobs())
  scheduler.on('job:updated', () => saveScheduledJobs())
  scheduler.on('job:deleted', () => saveScheduledJobs())

  // Periodic save every 5 min as a safety net
  setInterval(() => saveScheduledJobs(), 5 * 60 * 1000)
}

// ─── Default Autonomy Jobs ──────────────────────────────────

const AUTONOMY_JOBS: CreateJobInput[] = [
  // ── 1. Prospective Memory Executor (every 5 min) ──
  {
    name: 'Prospective Memory Check',
    description: 'Scan prospective memories for due reminders and condition triggers, then execute them',
    taskPrompt: `You are running a background check on my prospective memory (reminders and intentions).
Check my prospective memories for any that are due or whose conditions may now be met.
For each due item: execute the intention, then mark it as completed.
For condition-based items: evaluate whether the condition is likely met based on recent context.
If nothing is due, simply confirm "No pending reminders."
Keep responses brief — this runs automatically every 5 minutes.`,
    taskPriority: 'low',
    taskContext: { _jobName: 'Prospective Memory Check', _autonomous: true },
    type: 'cron',
    cronExpression: '*/5 * * * *',
  },

  // ── 2. Memory Consolidation (every 4 hours) ──
  {
    name: 'Memory Consolidation',
    description: 'Run memory decay, consolidation (episodic→semantic), and deduplication',
    taskPrompt: `Run a memory maintenance cycle:
1. Review recent episodic memories — identify any high-importance ones that should be promoted to semantic facts
2. Look for near-duplicate semantic memories and consolidate them
3. Check for contradictory facts in semantic memory and flag them
4. Briefly report: how many memories processed, any promotions or dedup.
Keep it concise — this is a background maintenance task.`,
    taskPriority: 'low',
    taskContext: { _jobName: 'Memory Consolidation', _autonomous: true },
    type: 'cron',
    cronExpression: '0 */4 * * *',
  },

  // ── 3. Daily Self-Reflection (10 PM daily) ──
  {
    name: 'Daily Self-Reflection',
    description: 'Review the day\'s tasks, extract patterns and lessons, store as semantic memory',
    taskPrompt: `Perform your daily self-reflection:
1. Review today's completed tasks and their outcomes
2. Identify patterns: what went well, what failed, what could improve
3. Extract 2-3 concrete lessons and store them as semantic memories
4. Check if any behavioral rules should be proposed based on today's patterns
5. Note any recurring user preferences you've observed today
Be introspective but concise. This reflection feeds your long-term learning.`,
    taskPriority: 'low',
    taskContext: { _jobName: 'Daily Self-Reflection', _autonomous: true },
    type: 'cron',
    cronExpression: '0 22 * * *',
  },

  // ── 4. Weekly Knowledge Audit (Sunday 10 AM) ──
  {
    name: 'Weekly Knowledge Audit',
    description: 'Audit semantic memories and people entries for accuracy and completeness',
    taskPrompt: `Perform your weekly knowledge audit:
1. Review your semantic memories — flag any that seem outdated or contradictory
2. Check people entries — are there any with stale or incomplete information?
3. Identify knowledge gaps: what topics does the user frequently ask about that you have little stored knowledge on?
4. Summarize: total facts stored, any issues found, recommendations for improvement
This audit keeps your knowledge base accurate and relevant.`,
    taskPriority: 'low',
    taskContext: { _jobName: 'Weekly Knowledge Audit', _autonomous: true },
    type: 'cron',
    cronExpression: '0 10 * * 0',
  },

  // ── 5. Morning Briefing Prep (7:30 AM weekdays) ──
  {
    name: 'Morning Briefing Prep',
    description: 'Pre-fetch Daily Pulse data so it\'s instant when the user opens the app',
    taskPrompt: `Prepare the morning briefing:
1. Fetch current weather for the user's location
2. Search for top 3 relevant tech/world news headlines
3. Check prospective memories for anything due today
4. Check if there are any pending rule proposals to review
5. Compile a brief morning summary (weather + key reminders + news highlights)
This should be ready before the user opens the app.`,
    taskPriority: 'normal',
    taskContext: { _jobName: 'Morning Briefing', _autonomous: true },
    type: 'cron',
    cronExpression: '30 7 * * 1-5',
  },

  // ── 6. Pending Rule Review Nudge (Monday noon) ──
  {
    name: 'Rule Review Nudge',
    description: 'Check for unreviewed behavioral rule proposals and notify the user',
    taskPrompt: `Check for pending behavioral rule proposals from the reflection system.
If there are any unreviewed proposals:
- List them briefly (title + what they'd change)
- Suggest the user review them in Settings → Rules
If no pending proposals, simply note "No pending rule proposals."
Keep it brief — this is a weekly nudge.`,
    taskPriority: 'low',
    taskContext: { _jobName: 'Rule Review Nudge', _autonomous: true },
    type: 'cron',
    cronExpression: '0 12 * * 1',
  },

  // ── 7. Stale Task Cleanup (3 AM daily) ──
  {
    name: 'Stale Task Cleanup',
    description: 'Find and clean up stuck/zombie tasks and orphaned data',
    taskPrompt: `Perform system hygiene:
1. Check for tasks stuck in "in_progress" or "planning" status for over 2 hours — these are likely zombie tasks from crashes
2. Report how many stale tasks were found
3. Check for any expired prospective memories that should be cleaned up
4. Report a brief system health summary
This is a background maintenance task — be concise.`,
    taskPriority: 'low',
    taskContext: { _jobName: 'Stale Task Cleanup', _autonomous: true },
    type: 'cron',
    cronExpression: '0 3 * * *',
  },

  // ── 8. Weekly Project Heartbeat (Friday 6 PM) ──
  {
    name: 'Weekly Project Heartbeat',
    description: 'Summarize the week\'s work, progress, and project status',
    taskPrompt: `Generate your weekly project heartbeat:
1. Review all tasks completed this week — group by topic/project
2. Identify what projects the user has been actively working on
3. Note any recurring themes or priorities
4. Create a brief weekly snapshot and store it as an episodic memory
5. If you notice a project that was active last week but quiet this week, mention it
This builds historical context for long-term project awareness.`,
    taskPriority: 'low',
    taskContext: { _jobName: 'Weekly Project Heartbeat', _autonomous: true },
    type: 'cron',
    cronExpression: '0 18 * * 5',
  },

  // ── 9. Calibration Report (Monday 9 AM) ──
  {
    name: 'Calibration Report',
    description: 'Analyze confidence calibration data and adjust agent thresholds',
    taskPrompt: `Generate your weekly calibration analysis:
1. Review the confidence calibration data from the past week
2. Check if any agents are consistently over-confident or under-confident
3. If there are patterns of over-confidence (stated high, actual low satisfaction), note which agents and suggest tightening escalation thresholds
4. Report: total tasks rated, overall accuracy, any agents needing adjustment
This helps me improve my confidence estimates over time.`,
    taskPriority: 'low',
    taskContext: { _jobName: 'Calibration Report', _autonomous: true },
    type: 'cron',
    cronExpression: '0 9 * * 1',
  },

  // ── 10. Conversation Summarizer (1 AM daily) ──
  {
    name: 'Conversation Summarizer',
    description: 'Summarize yesterday\'s chat sessions for long-term recall',
    taskPrompt: `Summarize yesterday's conversations:
1. Review chat sessions from yesterday that haven't been summarized
2. For each session: generate a 2-3 sentence summary capturing the key topic and outcome
3. Store each summary as an episodic memory with appropriate tags
4. Note any unfinished topics or follow-ups that should become prospective memories
This enables long-term narrative recall — remembering WHAT was discussed, not just extracted facts.`,
    taskPriority: 'low',
    taskContext: { _jobName: 'Conversation Summarizer', _autonomous: true },
    type: 'cron',
    cronExpression: '0 1 * * *',
  },
]

/** Seed default autonomy jobs if they don't exist yet */
export function seedAutonomyJobs(): void {
  const db = getDatabase()
  const scheduler = getScheduler()
  const existingJobs = scheduler.getJobs()

  // Check if we've already seeded (use a setting flag)
  const seeded = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'autonomy_jobs_seeded')
  if (seeded?.value === '"true"') {
    console.log('[Autonomy] Default jobs already seeded, skipping')
    return
  }

  let created = 0
  for (const jobInput of AUTONOMY_JOBS) {
    // Skip if a job with the same name already exists
    if (existingJobs.some((j) => j.name === jobInput.name)) continue

    scheduler.createJob(jobInput)
    created++
  }

  if (created > 0) {
    console.log(`[Autonomy] Seeded ${created} default autonomy jobs`)
    // Save immediately
    saveScheduledJobs()
  }

  // Mark as seeded
  db.run(
    `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    'autonomy_jobs_seeded', '"true"'
  )
}

/**
 * Initialize the full autonomy system:
 * 1. Load persisted jobs from DB
 * 2. Seed default autonomy jobs if first run
 * 3. Start persistence listeners
 */
export function initAutonomySystem(): void {
  loadScheduledJobs()
  seedAutonomyJobs()
  startSchedulerPersistence()
  console.log('[Autonomy] System initialized')
}
