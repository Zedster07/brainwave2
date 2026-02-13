/**
 * Auto-Update System — powered by electron-updater
 *
 * Checks for updates from GitHub Releases on app launch.
 * Sends progress events to the renderer via IPC.
 * User can accept/dismiss updates from the Settings UI.
 */
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/types'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  progress?: number
  error?: string
  releaseNotes?: string
}

let currentStatus: UpdateStatus = { state: 'idle' }

function sendStatusToRenderer(status: UpdateStatus): void {
  currentStatus = status
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.UPDATE_STATUS, status)
    }
  }
}

export function initAutoUpdater(): void {
  // ── Configure ──
  autoUpdater.autoDownload = false           // Let user decide
  autoUpdater.autoInstallOnAppQuit = true     // Install on next restart if downloaded
  autoUpdater.allowPrerelease = false

  // Suppress default dialog — we handle UI ourselves
  autoUpdater.autoRunAppAfterInstall = true

  // ── Events ──
  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for update...')
    sendStatusToRenderer({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log(`[Updater] Update available: v${info.version}`)
    sendStatusToRenderer({
      state: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => n.note).join('\n')
          : undefined,
    })
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] App is up to date')
    sendStatusToRenderer({ state: 'not-available' })
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    console.log(`[Updater] Download progress: ${progress.percent.toFixed(1)}%`)
    sendStatusToRenderer({
      state: 'downloading',
      progress: Math.round(progress.percent),
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    console.log(`[Updater] Update downloaded: v${info.version}`)
    sendStatusToRenderer({
      state: 'downloaded',
      version: info.version,
    })
  })

  autoUpdater.on('error', (err: Error) => {
    console.error('[Updater] Error:', err.message)
    sendStatusToRenderer({
      state: 'error',
      error: err.message,
    })
  })

  // ── IPC Handlers ──

  // Get current update status
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK_STATUS, () => currentStatus)

  // Manually check for updates
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      console.error('[Updater] Check failed:', err)
    }
  })

  // Start downloading the available update
  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async () => {
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      console.error('[Updater] Download failed:', err)
    }
  })

  // Install & restart
  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => {
    autoUpdater.quitAndInstall(false, true)
  })

  // ── Auto-check on launch (after a brief delay) ──
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[Updater] Initial check failed:', err.message)
    })
  }, 5000)
}
