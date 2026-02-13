import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers, applyModelOverrides } from './ipc'
import { createTray, destroyTray } from './services/tray.service'
import { getScheduler } from './services/scheduler.service'
import { getDatabase } from './db/database'
import { MigrationRunner } from './db/migrations'
import { ALL_MIGRATIONS } from './db/migrations/index'
import { LLMFactory } from './llm'
import { initMemoryManager } from './memory/memory-manager'
import { getDecayService } from './memory/decay'
import { getHardEngine, getSoftEngine } from './rules'
import { getOrchestrator } from './agents/orchestrator'
import { initAutoUpdater } from './updater'
import { getMcpRegistry } from './mcp'
import { getPluginRegistry } from './plugins'
import { getNotificationService } from './services/notification.service'

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
  // ── Grant microphone permission for Web Speech API ──
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'audioCapture']
    callback(allowed.includes(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media'
  })

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

    // ── Load Ollama config (host URL — no API key needed) ──
    const ollamaHost = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'ollama_host')
    const ollamaModel = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'ollama_default_model')
    const host = ollamaHost?.value ? JSON.parse(ollamaHost.value) : 'http://localhost:11434'
    const ollamaDefaultModel = ollamaModel?.value ? JSON.parse(ollamaModel.value) : undefined
    LLMFactory.configure('ollama', { apiKey: host, defaultModel: ollamaDefaultModel })
    console.log(`[Main] Ollama configured at ${host}`)

    // Restore saved model mode (beast / normal / economy / local)
    const savedMode = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'model_mode')
    if (savedMode?.value) {
      const mode = JSON.parse(savedMode.value) as string
      if (['beast', 'normal', 'economy', 'local'].includes(mode)) {
        LLMFactory.setMode(mode as 'beast' | 'normal' | 'economy' | 'local')
        console.log(`[Main] Model mode restored: ${mode}`)
        // Apply any per-agent overrides saved for this mode
        applyModelOverrides(db, mode)
      }
    }
  } catch (err) {
    console.warn('[Main] Failed to load LLM keys from DB:', err)
  }

  // ── Initialize Memory Manager ──
  initMemoryManager()

  // ── Start Memory Decay Service (Ebbinghaus forgetting curve) ──
  const decayService = getDecayService()
  decayService.start()

  // ── Initialize Rules Engines ──
  getHardEngine()   // loads safety.rules.json (creates defaults if missing)
  getSoftEngine()   // loads behavior.rules.json (creates defaults if missing)
  console.log('[Main] Rules engines initialized')

  // Register IPC handlers before creating window
  registerIpcHandlers()

  // ── Initialize Notification Service ──
  getNotificationService().init()

  // ── Initialize MCP (connect to auto-connect servers) ──
  getMcpRegistry().initialize().catch((err) => {
    console.warn('[Main] MCP initialization error:', err)
  })

  // ── Initialize Plugins (load and register custom agents) ──
  getPluginRegistry().initialize()

  // ── Auto-Update (checks GitHub Releases on launch) ──
  initAutoUpdater()

  createWindow()

  // System tray — keeps the app alive in the background
  createTray(() => mainWindow)

  // Start the scheduler service
  const scheduler = getScheduler()
  scheduler.start()

  // When a scheduled job fires, submit it as a task to the Orchestrator
  scheduler.on('job:execute', (payload) => {
    console.log(`[Main] Scheduled job executing: ${payload.jobId} → "${payload.taskPrompt}"`)

    // Notify: scheduled job starting
    getNotificationService().send({
      title: 'Scheduled Job Starting',
      body: payload.taskPrompt.slice(0, 120),
      type: 'scheduler',
      jobId: payload.jobId,
    })

    const orchestrator = getOrchestrator()
    orchestrator.submitTask(payload.taskPrompt, payload.taskPriority ?? 'normal').catch((err: Error) => {
      console.error(`[Main] Scheduled task failed:`, err)
    })
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
  getDecayService().stop()
  getMcpRegistry().disconnectAll().catch(() => {})
  destroyTray()
  getDatabase().close()
})

export { mainWindow }
