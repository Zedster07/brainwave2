/**
 * Notification Service — OS-level + in-app notifications
 *
 * Listens to event bus events and fires Electron Notification API
 * for OS-level toasts, plus forwards to renderer for in-app display.
 *
 * Notification triggers:
 *   1. Task completed / failed
 *   2. Scheduled job starting
 *   3. Scheduled job completed
 *   4. Agent-initiated via send_notification tool
 */
import { Notification, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC_CHANNELS } from '@shared/types'
import type { NotificationPayload, NotificationType } from '@shared/types'
import { getEventBus } from '../agents/event-bus'
import { getDatabase } from '../db/database'
import { getSoftEngine } from '../rules'

// ─── Notification Service ───────────────────────────────────

class NotificationService {
  private initialized = false
  /** Track last budget alert to avoid spamming (one per threshold crossing) */
  private lastBudgetAlertPercent = 0

  /** Wire up all event bus listeners */
  init(): void {
    if (this.initialized) return
    this.initialized = true

    const bus = getEventBus()

    // 1. Task completed
    bus.onEvent('task:completed', (data) => {
      const result = typeof data.result === 'string'
        ? data.result
        : 'Task finished successfully'
      this.send({
        title: 'Task Completed',
        body: result,
        type: 'task',
        taskId: data.taskId,
      })
    })

    // 2. Task failed
    bus.onEvent('task:failed', (data) => {
      this.send({
        title: 'Task Failed',
        body: data.error ?? 'Unknown error',
        type: 'task',
        taskId: data.taskId,
      })
    })

    // 3. notification:send event (from local tool or anywhere)
    bus.onEvent('notification:send', (data) => {
      this.send({
        title: data.title,
        body: data.body,
        type: data.type as NotificationType,
        taskId: data.taskId,
        jobId: data.jobId,
      })
    })

    // 4. Cost update — check monthly budget
    bus.onEvent('agent:cost-update', () => {
      this.checkMonthlyBudget()
    })

    console.log('[NotificationService] Initialized — listening for events')
  }

  /**
   * Send a notification:
   *   - OS-level via Electron Notification API
   *   - In-app via IPC push to renderer
   */
  send(opts: {
    title: string
    body: string
    type: NotificationType
    taskId?: string
    jobId?: string
  }): void {
    const payload: NotificationPayload = {
      id: randomUUID(),
      title: opts.title,
      body: opts.body,
      type: opts.type,
      taskId: opts.taskId,
      jobId: opts.jobId,
      timestamp: Date.now(),
    }

    // OS-level notification (only if supported)
    if (Notification.isSupported()) {
      const osNotif = new Notification({
        title: payload.title,
        body: payload.body,
        silent: false,
      })
      osNotif.show()

      // Focus window when user clicks the notification
      osNotif.on('click', () => {
        const wins = BrowserWindow.getAllWindows()
        if (wins.length > 0) {
          const win = wins[0]
          if (win.isMinimized()) win.restore()
          win.focus()
        }
      })
    }

    // Forward to renderer for in-app toast
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(IPC_CHANNELS.NOTIFICATION, payload)
    })

    console.log(`[Notification] ${payload.type}: ${payload.title} — ${payload.body}`)
  }

  /**
   * Check monthly spend against budget alert threshold.
   * Fires a notification when spend exceeds the configured limit.
   * Throttled to one alert per hour to avoid spam.
   */
  private lastBudgetAlertAt = 0
  private checkMonthlyBudget(): void {
    // Throttle: max one alert per hour
    const now = Date.now()
    if (now - this.lastBudgetAlertAt < 3_600_000) return

    try {
      const db = getDatabase()
      const threshold = getSoftEngine().getMonthlyBudgetAlert()

      // Sum cost_usd for current month
      const row = db.get(
        `SELECT COALESCE(SUM(cost_usd), 0.0) as total
         FROM agent_runs
         WHERE started_at >= date('now', 'start of month')`,
      ) as { total: number } | undefined

      const monthlySpend = row?.total ?? 0
      if (monthlySpend >= threshold) {
        this.lastBudgetAlertAt = now
        this.send({
          title: '💰 Monthly Budget Alert',
          body: `Monthly spend $${monthlySpend.toFixed(2)} has reached the $${threshold.toFixed(2)} alert threshold.`,
          type: 'system',
        })
        console.warn(
          `[NotificationService] Budget alert: $${monthlySpend.toFixed(2)} / $${threshold.toFixed(2)} threshold`,
        )
      }
    } catch (err) {
      console.warn('[NotificationService] Failed to check monthly budget:', err)
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: NotificationService | null = null

export function getNotificationService(): NotificationService {
  if (!instance) {
    instance = new NotificationService()
  }
  return instance
}
