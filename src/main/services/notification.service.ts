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

// ─── Notification Service ───────────────────────────────────

class NotificationService {
  private initialized = false

  /** Wire up all event bus listeners */
  init(): void {
    if (this.initialized) return
    this.initialized = true

    const bus = getEventBus()

    // 1. Task completed
    bus.onEvent('task:completed', (data) => {
      const result = typeof data.result === 'string'
        ? data.result.slice(0, 120)
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
        body: data.error?.slice(0, 120) ?? 'Unknown error',
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
}

// ─── Singleton ──────────────────────────────────────────────

let instance: NotificationService | null = null

export function getNotificationService(): NotificationService {
  if (!instance) {
    instance = new NotificationService()
  }
  return instance
}
