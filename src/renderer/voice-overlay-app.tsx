import React, { useEffect, useState, useRef, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import type { VoiceOverlayStatePayload } from '@shared/types'

type OverlayState = 'listening' | 'processing' | 'error' | 'idle'

function VoiceOverlayApp() {
  const [state, setState] = useState<OverlayState>('listening')
  const [message, setMessage] = useState('')
  const [audioLevel, setAudioLevel] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number>(0)
  const mimeTypeRef = useRef<string>('audio/webm')

  // Start recording immediately on mount
  useEffect(() => {
    startRecording()

    const unsub = window.voiceOverlay?.onStateChange((payload: VoiceOverlayStatePayload) => {
      setState(payload.state)
      if (payload.message) setMessage(payload.message)
    })

    return () => {
      unsub?.()
      stopRecording(false) // cleanup without submitting
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Audio level analysis for visualization
      const audioCtx = new AudioContext()
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      analyserRef.current = analyser

      // Animate audio level
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteFrequencyData(dataArray)
        const avg = dataArray.reduce((sum, v) => sum + v, 0) / dataArray.length
        setAudioLevel(avg / 255)
        animFrameRef.current = requestAnimationFrame(tick)
      }
      tick()

      // MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/ogg'
      mimeTypeRef.current = mimeType

      const recorder = new MediaRecorder(stream, { mimeType })
      audioChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      mediaRecorderRef.current = recorder
      recorder.start(250)
      setState('listening')
    } catch {
      setState('error')
      setMessage('Microphone access denied')
    }
  }, [])

  const stopRecording = useCallback(async (submit = true) => {
    cancelAnimationFrame(animFrameRef.current)
    setAudioLevel(0)

    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return

    return new Promise<void>((resolve) => {
      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null

        if (submit && audioChunksRef.current.length > 0) {
          setState('processing')
          setMessage('Transcribing...')
          const blob = new Blob(audioChunksRef.current, { type: mimeTypeRef.current })
          const buffer = await blob.arrayBuffer()
          try {
            await window.voiceOverlay?.submitAudio(buffer, mimeTypeRef.current)
          } catch {
            setState('error')
            setMessage('Failed to submit')
          }
        }
        resolve()
      }
      recorder.stop()
    })
  }, [])

  // Listen for global key release (main process sends state change to 'idle' which triggers stop)
  useEffect(() => {
    if (state === 'idle') {
      stopRecording(true)
    }
  }, [state, stopRecording])

  // Pulse ring sizes based on audio level
  const ring1Scale = 1 + audioLevel * 0.4
  const ring2Scale = 1 + audioLevel * 0.7
  const ring3Scale = 1 + audioLevel * 1.0

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'transparent',
    }}>
      {/* Outer glow rings */}
      <div style={{ position: 'relative', width: 160, height: 160 }}>
        {/* Ring 3 (outermost) */}
        <div style={{
          position: 'absolute', inset: 0,
          borderRadius: '50%',
          border: '1px solid rgba(99, 102, 241, 0.15)',
          transform: `scale(${ring3Scale})`,
          transition: 'transform 0.1s ease-out',
        }} />
        {/* Ring 2 */}
        <div style={{
          position: 'absolute', inset: 15, 
          borderRadius: '50%',
          border: '1px solid rgba(99, 102, 241, 0.25)',
          transform: `scale(${ring2Scale})`,
          transition: 'transform 0.1s ease-out',
        }} />
        {/* Ring 1 */}
        <div style={{
          position: 'absolute', inset: 30,
          borderRadius: '50%',
          border: '1px solid rgba(99, 102, 241, 0.4)',
          transform: `scale(${ring1Scale})`,
          transition: 'transform 0.1s ease-out',
        }} />
        
        {/* Center mic circle */}
        <div style={{
          position: 'absolute',
          inset: 40,
          borderRadius: '50%',
          background: state === 'listening'
            ? `radial-gradient(circle, rgba(99, 102, 241, ${0.8 + audioLevel * 0.2}) 0%, rgba(79, 70, 229, 0.9) 60%, rgba(55, 48, 163, 0.95) 100%)`
            : state === 'processing'
              ? 'radial-gradient(circle, rgba(245, 158, 11, 0.8) 0%, rgba(217, 119, 6, 0.9) 100%)'
              : 'radial-gradient(circle, rgba(239, 68, 68, 0.8) 0%, rgba(185, 28, 28, 0.9) 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: state === 'listening'
            ? `0 0 ${20 + audioLevel * 40}px rgba(99, 102, 241, ${0.3 + audioLevel * 0.4}), inset 0 0 20px rgba(255,255,255,0.1)`
            : state === 'processing'
              ? '0 0 30px rgba(245, 158, 11, 0.4), inset 0 0 20px rgba(255,255,255,0.1)'
              : '0 0 20px rgba(239, 68, 68, 0.3)',
          transition: 'background 0.3s ease, box-shadow 0.15s ease-out',
        }}>
          {state === 'processing' ? (
            <SpinnerIcon />
          ) : (
            <MicIcon isError={state === 'error'} />
          )}
        </div>
      </div>

      {/* Status text */}
      <div style={{
        marginTop: 16,
        fontSize: 12,
        fontWeight: 500,
        color: state === 'error' ? '#f87171' : 'rgba(255, 255, 255, 0.7)',
        textAlign: 'center',
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
      }}>
        {state === 'listening' && 'Listening...'}
        {state === 'processing' && (message || 'Processing...')}
        {state === 'error' && (message || 'Error')}
      </div>
    </div>
  )
}

function MicIcon({ isError }: { isError: boolean }) {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={isError ? '#fca5a5' : '#fff'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="1" width="6" height="12" rx="3" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function SpinnerIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </svg>
  )
}

// Mount
const root = createRoot(document.getElementById('root')!)
root.render(<VoiceOverlayApp />)
