/**
 * Preload script for the Voice Overlay window.
 * Exposes a minimal API for recording + submitting audio.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type VoiceOverlayAPI, type VoiceOverlayStatePayload } from '@shared/types'

const api: VoiceOverlayAPI = {
  submitAudio: (audioBuffer: ArrayBuffer, mimeType: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.VOICE_OVERLAY_SUBMIT, audioBuffer, mimeType),

  onStateChange: (callback: (state: VoiceOverlayStatePayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: VoiceOverlayStatePayload) => callback(state)
    ipcRenderer.on(IPC_CHANNELS.VOICE_OVERLAY_STATE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_OVERLAY_STATE, handler)
  },

  dismiss: () => ipcRenderer.send(IPC_CHANNELS.VOICE_OVERLAY_DISMISS),
}

contextBridge.exposeInMainWorld('voiceOverlay', api)
