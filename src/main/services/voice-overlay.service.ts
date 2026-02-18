/**
 * Voice Overlay Service
 *
 * Manages global hotkey (Ctrl+Shift+Space) for push-to-talk voice input.
 * Creates two overlay windows:
 *   1. Voice overlay — tiny centered mic animation while recording
 *   2. Result card — slides in from the left when task completes
 *
 * Flow:
 *   Hold Ctrl+Shift+Space → show overlay + start recording
 *   Release → stop recording → transcribe (Whisper) → submit task
 *   Task completes in background → show result card
 *   User clicks ✕ → dismiss result card
 */
import {
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  session,
} from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { IPC_CHANNELS } from '@shared/types'
import { getOrchestrator } from '../agents/orchestrator'
import { getDatabase } from '../db/database'
import { getEventBus } from '../agents/event-bus'

let voiceOverlayWindow: BrowserWindow | null = null
let resultCardWindow: BrowserWindow | null = null
let isHotkeyDown = false
let activeTaskId: string | null = null
let activePrompt: string | null = null

// ─── Window Creation ────────────────────────────────────────

function createVoiceOverlay(): BrowserWindow {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize

  const win = new BrowserWindow({
    width: 220,
    height: 250,
    x: Math.round(screenW / 2 - 110),
    y: Math.round(screenH / 2 - 125),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,         // Don't steal focus from other apps
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../../preload/voice-overlay.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Ensure mic permissions for the overlay window
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'mediaKeySystem', 'audioCapture'].includes(permission))
  })

  // Load the overlay renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/voice-overlay.html`)
  } else {
    win.loadFile(join(__dirname, '../../renderer/voice-overlay.html'))
  }

  win.on('closed', () => {
    voiceOverlayWindow = null
  })

  return win
}

function createResultCard(): BrowserWindow {
  const { height: screenH } = screen.getPrimaryDisplay().workAreaSize

  const win = new BrowserWindow({
    width: 420,
    height: 360,
    x: 16,
    y: Math.round(screenH / 2 - 180),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: true,          // Needs focus for the close button
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../../preload/voice-result.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/voice-result.html`)
  } else {
    win.loadFile(join(__dirname, '../../renderer/voice-result.html'))
  }

  win.on('closed', () => {
    resultCardWindow = null
  })

  return win
}

// ─── Hotkey Handling ────────────────────────────────────────

function onHotkeyDown(): void {
  if (isHotkeyDown) return // Already recording
  isHotkeyDown = true

  console.log('[VoiceOverlay] Hotkey pressed — starting recording')

  // Ensure overlay window exists and is loaded
  if (!voiceOverlayWindow || voiceOverlayWindow.isDestroyed()) {
    voiceOverlayWindow = createVoiceOverlay()
    voiceOverlayWindow.once('ready-to-show', () => {
      voiceOverlayWindow?.showInactive()
      voiceOverlayWindow?.webContents.send(IPC_CHANNELS.VOICE_OVERLAY_STATE, {
        state: 'listening',
      })
    })
  } else {
    voiceOverlayWindow.showInactive()
    voiceOverlayWindow.webContents.send(IPC_CHANNELS.VOICE_OVERLAY_STATE, {
      state: 'listening',
    })
  }
}

function onHotkeyUp(): void {
  if (!isHotkeyDown) return
  isHotkeyDown = false

  console.log('[VoiceOverlay] Hotkey released — stopping recording')

  // Tell the overlay to stop recording and submit
  if (voiceOverlayWindow && !voiceOverlayWindow.isDestroyed()) {
    voiceOverlayWindow.webContents.send(IPC_CHANNELS.VOICE_OVERLAY_STATE, {
      state: 'idle', // triggers stop + submit in renderer
    })
  }
}

// ─── IPC Handlers ───────────────────────────────────────────

function registerVoiceOverlayIpc(): void {
  // Overlay renderer submits audio buffer after recording stops
  ipcMain.handle(IPC_CHANNELS.VOICE_OVERLAY_SUBMIT, async (_event, audioBuffer: ArrayBuffer, mimeType: string) => {
    console.log('[VoiceOverlay] Audio received, transcribing...')

    // Show processing state
    if (voiceOverlayWindow && !voiceOverlayWindow.isDestroyed()) {
      voiceOverlayWindow.webContents.send(IPC_CHANNELS.VOICE_OVERLAY_STATE, {
        state: 'processing',
        message: 'Transcribing...',
      })
    }

    try {
      // Reuse the existing STT pipeline
      const transcript = await transcribeAudio(audioBuffer, mimeType)

      if ('error' in transcript) {
        if (voiceOverlayWindow && !voiceOverlayWindow.isDestroyed()) {
          voiceOverlayWindow.webContents.send(IPC_CHANNELS.VOICE_OVERLAY_STATE, {
            state: 'error',
            message: transcript.error,
          })
        }
        // Auto-hide after showing error
        setTimeout(() => hideVoiceOverlay(), 2000)
        return
      }

      const text = transcript.text?.trim()
      if (!text) {
        hideVoiceOverlay()
        return
      }

      console.log(`[VoiceOverlay] Transcript: "${text}"`)
      activePrompt = text

      // Update overlay to show submitting state
      if (voiceOverlayWindow && !voiceOverlayWindow.isDestroyed()) {
        voiceOverlayWindow.webContents.send(IPC_CHANNELS.VOICE_OVERLAY_STATE, {
          state: 'processing',
          message: 'Submitting task...',
        })
      }

      // Submit task via orchestrator
      const orchestrator = getOrchestrator()
      const db = getDatabase()

      // Create a voice session
      const { randomUUID } = await import('crypto')
      const sessionId = randomUUID()
      const now = Date.now()
      const sessionTitle = `🎙️ Voice`
      db.run(
        `INSERT INTO chat_sessions (id, title, session_type, created_at, updated_at) VALUES (?, ?, 'autonomous', ?, ?)`,
        sessionId, sessionTitle, now, now
      )

      // Forward session to main renderer
      BrowserWindow.getAllWindows().forEach((win) => {
        if (win !== voiceOverlayWindow && win !== resultCardWindow) {
          win.webContents.send('session:created', {
            id: sessionId, title: sessionTitle, type: 'autonomous',
            createdAt: now, updatedAt: now,
          })
        }
      })

      const task = await orchestrator.submitTask(text, 'normal', sessionId)
      activeTaskId = task.id

      // Hide the voice overlay — task is now running in background
      hideVoiceOverlay()
    } catch (err) {
      console.error('[VoiceOverlay] Submit failed:', err)
      if (voiceOverlayWindow && !voiceOverlayWindow.isDestroyed()) {
        voiceOverlayWindow.webContents.send(IPC_CHANNELS.VOICE_OVERLAY_STATE, {
          state: 'error',
          message: 'Failed to submit task',
        })
      }
      setTimeout(() => hideVoiceOverlay(), 2000)
    }
  })

  // Dismiss handler (from result card close button)
  ipcMain.on(IPC_CHANNELS.VOICE_OVERLAY_DISMISS, () => {
    hideResultCard()
  })
}

// ─── Task Completion Listener ───────────────────────────────

function watchForTaskCompletion(): void {
  const eventBus = getEventBus()

  eventBus.onEvent('task:completed', (data) => {
    if (data.taskId !== activeTaskId) return

    console.log(`[VoiceOverlay] Task ${data.taskId} completed — showing result card`)
    showResultCard({
      taskId: data.taskId,
      prompt: activePrompt ?? '',
      result: data.result ?? 'Task completed.',
      status: 'completed',
    })
    activeTaskId = null
    activePrompt = null
  })

  eventBus.onEvent('task:failed', (data) => {
    if (data.taskId !== activeTaskId) return

    console.log(`[VoiceOverlay] Task ${data.taskId} failed — showing result card`)
    showResultCard({
      taskId: data.taskId,
      prompt: activePrompt ?? '',
      result: data.error ?? 'Task failed.',
      status: 'failed',
    })
    activeTaskId = null
    activePrompt = null
  })
}

// ─── Window Helpers ─────────────────────────────────────────

function hideVoiceOverlay(): void {
  if (voiceOverlayWindow && !voiceOverlayWindow.isDestroyed()) {
    voiceOverlayWindow.hide()
  }
}

function showResultCard(result: { taskId: string; prompt: string; result: string; status: 'completed' | 'failed' }): void {
  if (!resultCardWindow || resultCardWindow.isDestroyed()) {
    resultCardWindow = createResultCard()
    resultCardWindow.once('ready-to-show', () => {
      resultCardWindow?.showInactive()
      resultCardWindow?.webContents.send(IPC_CHANNELS.VOICE_OVERLAY_RESULT, result)
    })
  } else {
    resultCardWindow.showInactive()
    resultCardWindow.webContents.send(IPC_CHANNELS.VOICE_OVERLAY_RESULT, result)
  }

  // Auto-dismiss after 30 seconds if user doesn't close it
  setTimeout(() => hideResultCard(), 30_000)
}

function hideResultCard(): void {
  if (resultCardWindow && !resultCardWindow.isDestroyed()) {
    resultCardWindow.hide()
  }
}

// ─── STT Reuse ──────────────────────────────────────────────

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
  const providerRow = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, 'stt_provider')

  const sttKey = keyRow ? JSON.parse(keyRow.value) : ''
  const sttProvider: string = providerRow ? JSON.parse(providerRow.value) : 'groq'

  if (!sttKey) {
    return { error: 'No STT API key configured. Go to Settings → Models.' }
  }

  let baseURL: string
  let model: string
  if (sttProvider === 'openai') {
    baseURL = 'https://api.openai.com/v1'
    model = 'whisper-1'
  } else {
    baseURL = 'https://api.groq.com/openai/v1'
    model = 'whisper-large-v3-turbo'
  }

  const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'wav'
  const tempPath = join(tmpdir(), `brainwave-voice-${randomUUID()}.${ext}`)
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
      text: typeof transcription === 'string'
        ? transcription
        : (transcription as unknown as { text: string }).text,
    }
  } catch (err) {
    console.error('[VoiceOverlay] STT error:', err)
    return { error: err instanceof Error ? err.message : 'Transcription failed' }
  } finally {
    try { unlinkSync(tempPath) } catch { /* ignore */ }
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Initialize the voice overlay system.
 * Call after app is ready and IPC handlers are registered.
 */
export function initVoiceOverlay(): void {
  registerVoiceOverlayIpc()
  watchForTaskCompletion()

  // Register global hotkey: Ctrl+Shift+Space
  // Note: Electron's globalShortcut doesn't have keyup events,
  // so we use a two-shortcut approach:
  //   - Register the main shortcut (fires on keydown, repeats while held)
  //   - Use a polling approach to detect release
  const accelerator = 'Ctrl+Shift+Space'

  const registered = globalShortcut.register(accelerator, () => {
    if (!isHotkeyDown) {
      onHotkeyDown()

      // Poll for key release — check every 100ms if keys are still held
      const pollInterval = setInterval(() => {
        // Use a native keyboard state check via a BrowserWindow query
        // Since Electron doesn't expose key state directly, we detect
        // "release" by the fact that no more accelerator callbacks fire.
        // We use a simple timeout: if the accelerator callback hasn't
        // fired for 300ms, consider the key released.
        if (isHotkeyDown && lastAcceleratorFire > 0 && Date.now() - lastAcceleratorFire > 300) {
          clearInterval(pollInterval)
          onHotkeyUp()
        }
      }, 100)
    }
    lastAcceleratorFire = Date.now()
  })

  if (!registered) {
    console.warn(`[VoiceOverlay] Failed to register global shortcut: ${accelerator}`)
  } else {
    console.log(`[VoiceOverlay] Global shortcut registered: ${accelerator}`)
  }
}

let lastAcceleratorFire = 0

/**
 * Cleanup: unregister global shortcut and close overlay windows.
 */
export function destroyVoiceOverlay(): void {
  globalShortcut.unregisterAll()

  if (voiceOverlayWindow && !voiceOverlayWindow.isDestroyed()) {
    voiceOverlayWindow.destroy()
    voiceOverlayWindow = null
  }
  if (resultCardWindow && !resultCardWindow.isDestroyed()) {
    resultCardWindow.destroy()
    resultCardWindow = null
  }

  console.log('[VoiceOverlay] Destroyed')
}
