/**
 * Preload script for the Voice Result card window.
 * Exposes a minimal API for receiving task results and dismissing.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type VoiceResultAPI, type VoiceOverlayResultPayload } from '@shared/types'

const api: VoiceResultAPI = {
  onResult: (callback: (result: VoiceOverlayResultPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: VoiceOverlayResultPayload) => callback(result)
    ipcRenderer.on(IPC_CHANNELS.VOICE_OVERLAY_RESULT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_OVERLAY_RESULT, handler)
  },

  dismiss: () => ipcRenderer.send(IPC_CHANNELS.VOICE_OVERLAY_DISMISS),
}

contextBridge.exposeInMainWorld('voiceResult', api)
