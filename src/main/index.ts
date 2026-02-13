import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { createTray, destroyTray } from './services/tray.service'
import { getScheduler } from './services/scheduler.service'
import { getDatabase } from './db/database'
import { MigrationRunner } from './db/migrations'
import { ALL_MIGRATIONS } from './db/migrations/index'
import { LLMFactory } from './llm'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0A0B0F',
    show: false,
    title: 'Brainwave 2',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Graceful show when ready
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Minimize to tray instead of closing (unless force-quitting)
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Load renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Open DevTools in dev
  if (is.dev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

// ─── App Lifecycle ──────────────────────────────────────────

app.whenReady().then(() => {
  // ── Initialize database & run migrations ──
  const db = getDatabase()
  const runner = new MigrationRunner(db)
  const { applied, current } = runner.migrate(ALL_MIGRATIONS)
  if (applied.length > 0) {
    console.log(`[Main] Applied ${applied.length} migration(s), schema at v${current}`)
  }

  // ── Load saved LLM API keys from DB ──
  try {
    const orKey = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'openrouter_api_key')
    if (orKey?.value) {
      LLMFactory.configure('openrouter', { apiKey: JSON.parse(orKey.value) })
      console.log('[Main] OpenRouter API key loaded')
    }

    const repKey = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'replicate_api_key')
    if (repKey?.value) {
      LLMFactory.configure('replicate', { apiKey: JSON.parse(repKey.value) })
      console.log('[Main] Replicate API key loaded')
    }
  } catch (err) {
    console.warn('[Main] Failed to load LLM keys from DB:', err)
  }

  // Register IPC handlers before creating window
  registerIpcHandlers()

  createWindow()

  // System tray — keeps the app alive in the background
  createTray(() => mainWindow)

  // Start the scheduler service
  const scheduler = getScheduler()
  scheduler.start()

  // When a scheduled job fires, submit it as a task
  scheduler.on('job:execute', (payload) => {
    console.log(`[Main] Scheduled job executing: ${payload.jobId} → "${payload.taskPrompt}"`)
    // TODO: Wire to Orchestrator.submitTask() once built
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // On macOS, keep running. On Windows/Linux, keep alive via tray.
  // Only quit when app.isQuitting is set (from tray "Quit" or app.quit())
})

app.on('before-quit', () => {
  app.isQuitting = true
  getScheduler().stop()
  destroyTray()
  getDatabase().close()
})

export { mainWindow }
