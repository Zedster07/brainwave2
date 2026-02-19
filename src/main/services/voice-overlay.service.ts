/**
 * Voice Overlay Service — v2 (Optimized)
 *
 * Toggle-based global hotkey (Ctrl+Shift+Space):
 *   Press once → show overlay + start recording
 *   Press again → stop recording → transcribe → submit task → hide
 *
 * Windows are pre-created at init and kept hidden for instant show/hide.
 */
import {
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
} from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { IPC_CHANNELS } from '@shared/types'
import { getOrchestrator } from '../agents/orchestrator'
import { getDatabase } from '../db/database'
import { getEventBus } from '../agents/event-bus'

// ─── State ──────────────────────────────────────────────────

let voiceWindow: BrowserWindow | null = null
let resultWindow: BrowserWindow | null = null
let isRecording = false
let isSubmitting = false // guard against duplicate audio submissions
let voiceWindowReady = false
let resultWindowReady = false
let activeTaskId: string | null = null
let activePrompt: string | null = null
let resultAutoDismissTimer: ReturnType<typeof setTimeout> | null = null

// ─── Window Factories ───────────────────────────────────────

function createVoiceWindow(): BrowserWindow {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize

  const win = new BrowserWindow({
    width: sw,
    height: sh,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/voice-overlay.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  // Grant mic permissions
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'mediaKeySystem', 'audioCapture'].includes(permission))
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = `${process.env['ELECTRON_RENDERER_URL']}/voice-overlay.html`
    console.log(`[VoiceOverlay] Loading voice window from: ${url}`)
    win.loadURL(url).catch((err) => {
      console.error('[VoiceOverlay] loadURL failed:', err)
    })
  } else {
    const filePath = join(__dirname, '../renderer/voice-overlay.html')
    console.log(`[VoiceOverlay] Loading voice window from file: ${filePath}`)
    win.loadFile(filePath).catch((err) => {
      console.error('[VoiceOverlay] loadFile failed:', err)
    })
  }

  win.webContents.on('did-finish-load', () => {
    console.log('[VoiceOverlay] Voice window HTML loaded (waiting for renderer ready signal)')
  })

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[VoiceOverlay] Voice window FAILED to load: ${code} ${desc}`)
  })

  // Prevent close — just hide
  win.on('close', (e) => {
    e.preventDefault()
    win.hide()
  })

  return win
}

function createResultWindow(): BrowserWindow {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize

  const win = new BrowserWindow({
    width: 420,
    height: 360,
    x: sw - 420 - 16,
    y: Math.round(sh / 2 - 180),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/voice-result.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/voice-result.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/voice-result.html'))
  }

  win.webContents.on('did-finish-load', () => {
    resultWindowReady = true
    console.log('[VoiceOverlay] Result window pre-loaded and ready')
  })

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[VoiceOverlay] Result window FAILED to load: ${code} ${desc}`)
  })

  win.on('close', (e) => {
    e.preventDefault()
    win.hide()
  })

  return win
}

// ─── Hotkey Toggle ──────────────────────────────────────────

function onHotkeyToggle(): void {
  if (isRecording) {
    // ── Stop recording ──
    isRecording = false
    console.log('[VoiceOverlay] Hotkey toggle → stop recording')

    if (voiceWindow && !voiceWindow.isDestroyed() && voiceWindowReady) {
      voiceWindow.webContents.send(IPC_CHANNELS.VOICE_OVERLAY_STATE, {
        state: 'processing',
        message: 'Processing...',
      })
    }
  } else {
    // ── Start recording ──
    if (!voiceWindow || voiceWindow.isDestroyed() || !voiceWindowReady) {
      console.warn('[VoiceOverlay] Voice window not ready, cannot start')
      return
    }

    isRecording = true
    console.log('[VoiceOverlay] Hotkey toggle → start recording')

    // Full-screen overlay — reposition to cover entire display
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
    voiceWindow.setBounds({ x: 0, y: 0, width: sw, height: sh })

    // Send IPC BEFORE showing so renderer updates content while still hidden
    voiceWindow.webContents.send(IPC_CHANNELS.VOICE_OVERLAY_STATE, { state: 'listening' })
    voiceWindow.showInactive()
    voiceWindow.moveTop() // Force z-order on Windows
    // Force compositor repaint — transparent windows on Windows can go blank after hide/show
    voiceWindow.webContents.invalidate()
    console.log(`[VoiceOverlay] Window visible=${voiceWindow.isVisible()}, bounds=${JSON.stringify(voiceWindow.getBounds())}`)
  }
}

// ─── IPC Handlers ───────────────────────────────────────────

function registerIpc(): void {
  // Audio submitted from the overlay renderer after recording stops
  ipcMain.handle(
    IPC_CHANNELS.VOICE_OVERLAY_SUBMIT,
    async (_event, audioBuffer: ArrayBuffer, mimeType: string) => {
      // Guard: ignore duplicate submissions (HMR can cause double IPC calls)
      if (isSubmitting) {
        console.warn('[VoiceOverlay] Ignoring duplicate audio submission')
        return
      }
      isSubmitting = true

      const audioSize = audioBuffer.byteLength
      console.log(`[VoiceOverlay] Audio received: ${(audioSize / 1024).toFixed(1)} KB, type=${mimeType}`)

      if (audioSize < 1000) {
        console.warn('[VoiceOverlay] Audio too short, ignoring')
        sendVoiceState('error', 'Recording too short — try again')
        setTimeout(() => hideVoice(), 1500)
        isSubmitting = false
        return
      }

      sendVoiceState('processing', 'Transcribing...')

      try {
        const transcript = await transcribeAudio(audioBuffer, mimeType)

        if ('error' in transcript) {
          console.error('[VoiceOverlay] STT error:', transcript.error)
          sendVoiceState('error', transcript.error)
          setTimeout(() => hideVoice(), 2500)
          return
        }

        const text = transcript.text?.trim()
        if (!text) {
          console.warn('[VoiceOverlay] Empty transcript')
          sendVoiceState('error', 'No speech detected')
          setTimeout(() => hideVoice(), 1500)
          return
        }

        console.log(`[VoiceOverlay] Transcript: "${text}"`)
        activePrompt = text

        sendVoiceState('processing', 'Submitting task...')

        // Create voice session + submit task
        const db = getDatabase()
        const { randomUUID } = await import('crypto')
        const sessionId = randomUUID()
        const now = Date.now()
        const sessionTitle = '🎙️ Voice'

        db.run(
          `INSERT INTO chat_sessions (id, title, session_type, created_at, updated_at) VALUES (?, ?, 'autonomous', ?, ?)`,
          sessionId,
          sessionTitle,
          now,
          now
        )

        // Notify main renderer about the new session
        BrowserWindow.getAllWindows().forEach((win) => {
          if (win !== voiceWindow && win !== resultWindow) {
            win.webContents.send('session:created', {
              id: sessionId,
              title: sessionTitle,
              type: 'autonomous',
              createdAt: now,
              updatedAt: now,
            })
          }
        })

        const orchestrator = getOrchestrator()
        const task = await orchestrator.submitTask(text, 'normal', sessionId)
        activeTaskId = task.id

        console.log(`[VoiceOverlay] Task submitted: ${task.id}`)

        // Hide overlay — task runs in background
        hideVoice()
      } catch (err) {
        console.error('[VoiceOverlay] Pipeline failed:', err)
        sendVoiceState('error', 'Failed to process')
        setTimeout(() => hideVoice(), 2500)
      } finally {
        isSubmitting = false
      }
    }
  )

  // Dismiss from either overlay
  ipcMain.on(IPC_CHANNELS.VOICE_OVERLAY_DISMISS, () => {
    if (resultAutoDismissTimer) clearTimeout(resultAutoDismissTimer)
    if (resultWindow && !resultWindow.isDestroyed()) resultWindow.hide()
  })

  // Renderer signals that React mounted and IPC listener is active
  ipcMain.on(IPC_CHANNELS.VOICE_OVERLAY_READY, () => {
    voiceWindowReady = true
    console.log('[VoiceOverlay] Renderer ready — voice overlay fully initialized')
  })
}

// ─── Task Completion Watcher ────────────────────────────────

function watchTaskCompletion(): void {
  const eventBus = getEventBus()

  eventBus.onEvent('task:completed', (data) => {
    if (data.taskId !== activeTaskId) return
    console.log(`[VoiceOverlay] Task completed: ${data.taskId}`)
    showResult({
      taskId: data.taskId,
      prompt: activePrompt ?? '',
      result: (data.result as string) ?? 'Task completed.',
      status: 'completed',
    })
    activeTaskId = null
    activePrompt = null
  })

  eventBus.onEvent('task:failed', (data) => {
    if (data.taskId !== activeTaskId) return
    console.log(`[VoiceOverlay] Task failed: ${data.taskId}`)
    showResult({
      taskId: data.taskId,
      prompt: activePrompt ?? '',
      result: (data.error as string) ?? 'Task failed.',
      status: 'failed',
    })
    activeTaskId = null
    activePrompt = null
  })
}

// ─── Helpers ────────────────────────────────────────────────

function sendVoiceState(state: string, message?: string): void {
  if (voiceWindow && !voiceWindow.isDestroyed() && voiceWindowReady) {
    voiceWindow.webContents.send(IPC_CHANNELS.VOICE_OVERLAY_STATE, { state, message })
  }
}

function hideVoice(): void {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    // Reset renderer state so it's ready for the next activation
    sendVoiceState('idle')
    voiceWindow.hide()
  }
}

function showResult(result: {
  taskId: string
  prompt: string
  result: string
  status: 'completed' | 'failed'
}): void {
  if (!resultWindow || resultWindow.isDestroyed() || !resultWindowReady) return

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  // Position on the right side of the screen
  resultWindow.setPosition(sw - 420 - 16, Math.round(sh / 2 - 180))
  // Send IPC BEFORE showing so renderer has content ready
  resultWindow.webContents.send(IPC_CHANNELS.VOICE_OVERLAY_RESULT, result)
  resultWindow.showInactive()
  resultWindow.moveTop() // Force z-order on Windows
  console.log(`[VoiceOverlay] Result window visible=${resultWindow.isVisible()}, bounds=${JSON.stringify(resultWindow.getBounds())}`)

  if (resultAutoDismissTimer) clearTimeout(resultAutoDismissTimer)
  resultAutoDismissTimer = setTimeout(() => {
    if (resultWindow && !resultWindow.isDestroyed()) resultWindow.hide()
  }, 30_000)
}

// ─── STT ────────────────────────────────────────────────────

async function transcribeAudio(
  audioBuffer: ArrayBuffer,
  mimeType: string
): Promise<{ text: string } | { error: string }> {
  const { writeFileSync, unlinkSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { randomUUID } = await import('crypto')
  const { default: OpenAI } = await import('openai')

  const db = getDatabase()
  const keyRow = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'stt_api_key')
  const providerRow = db.get<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    'stt_provider'
  )

  const sttKey = keyRow ? JSON.parse(keyRow.value) : ''
  const sttProvider: string = providerRow ? JSON.parse(providerRow.value) : 'groq'

  if (!sttKey) {
    return { error: 'No STT API key. Go to Settings → Models.' }
  }

  const baseURL =
    sttProvider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.groq.com/openai/v1'
  const model = sttProvider === 'openai' ? 'whisper-1' : 'whisper-large-v3-turbo'

  const ext = mimeType.includes('webm')
    ? 'webm'
    : mimeType.includes('ogg')
      ? 'ogg'
      : 'wav'
  const tempPath = join(tmpdir(), `bw-voice-${randomUUID()}.${ext}`)
  writeFileSync(tempPath, Buffer.from(audioBuffer))

  try {
    const client = new OpenAI({ apiKey: sttKey, baseURL, timeout: 30_000 })
    const fs = await import('node:fs')
    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model,
      response_format: 'text',
    })
    return {
      text:
        typeof transcription === 'string'
          ? transcription
          : (transcription as unknown as { text: string }).text,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Transcription failed' }
  } finally {
    try {
      unlinkSync(tempPath)
    } catch {
      /* ignore */
    }
  }
}

// ─── Public API ─────────────────────────────────────────────

export function initVoiceOverlay(): void {
  console.log('[VoiceOverlay] Initializing...')

  try {
    registerIpc()
    watchTaskCompletion()

    // Pre-create windows (hidden) — they'll be instant to show later
    voiceWindow = createVoiceWindow()
    console.log(`[VoiceOverlay] Voice window created, id=${voiceWindow?.id}`)
    resultWindow = createResultWindow()
    console.log(`[VoiceOverlay] Result window created, id=${resultWindow?.id}`)

    // Toggle hotkey: press once to start, again to stop
    const accel = 'Ctrl+Shift+Space'
    const ok = globalShortcut.register(accel, onHotkeyToggle)

    if (!ok) {
      console.error(`[VoiceOverlay] FAILED to register shortcut: ${accel}`)
    } else {
      console.log(`[VoiceOverlay] Ready — ${accel} to toggle voice input`)
    }
  } catch (err) {
    console.error('[VoiceOverlay] INIT FAILED:', err)
  }
}

export function destroyVoiceOverlay(): void {
  globalShortcut.unregisterAll()
  if (resultAutoDismissTimer) clearTimeout(resultAutoDismissTimer)

  // Force-destroy windows (bypass close prevention)
  for (const win of [voiceWindow, resultWindow]) {
    if (win && !win.isDestroyed()) {
      win.removeAllListeners('close')
      win.destroy()
    }
  }
  voiceWindow = null
  resultWindow = null
  voiceWindowReady = false
  resultWindowReady = false
  isRecording = false
  isSubmitting = false

  console.log('[VoiceOverlay] Destroyed')
}
