/**
 * useVoice — Voice input/output for Electron
 *
 * Speech-to-text: MediaRecorder → IPC → Whisper API (Groq/OpenAI)
 * Text-to-speech: Browser SpeechSynthesis (works fine in Electron)
 *
 * Web Speech API (SpeechRecognition) doesn't work in Electron because
 * Google's API keys are not bundled. We use MediaRecorder to capture audio
 * and send it to a Whisper-compatible API via the main process.
 */
import { useState, useCallback, useRef, useEffect } from 'react'

// ─── Types ──────────────────────────────────────────────────

interface VoiceState {
  /** Whether voice input is currently recording */
  isListening: boolean
  /** Whether TTS is currently speaking */
  isSpeaking: boolean
  /** Whether audio recording is available */
  canListen: boolean
  /** Whether the browser supports speech synthesis */
  canSpeak: boolean
  /** Status message shown during recording/processing */
  interimTranscript: string
  /** Error message if something went wrong */
  error: string | null
}

interface VoiceActions {
  /** Start recording voice input */
  startListening: () => void
  /** Stop recording and transcribe */
  stopListening: () => void
  /** Toggle recording on/off */
  toggleListening: () => void
  /** Speak text aloud using TTS */
  speak: (text: string) => void
  /** Stop speaking */
  stopSpeaking: () => void
}

interface UseVoiceOptions {
  /** Called with the final transcript when transcription completes */
  onResult?: (transcript: string) => void
  /** Language for TTS (default: 'en-US') */
  lang?: string
  /** Unused — kept for API compatibility */
  continuous?: boolean
}

// ─── Hook ───────────────────────────────────────────────────

export function useVoice(options: UseVoiceOptions = {}): VoiceState & VoiceActions {
  const { onResult, lang = 'en-US' } = options

  const canListen = typeof navigator?.mediaDevices?.getUserMedia === 'function'
  const canSpeak = 'speechSynthesis' in window

  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [interimTranscript, setInterimTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const onResultRef = useRef(onResult)

  // Keep the callback ref up-to-date
  useEffect(() => {
    onResultRef.current = onResult
  }, [onResult])

  const startListening = useCallback(async () => {
    setError(null)
    setInterimTranscript('')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Prefer webm (smaller), fall back to whatever is available
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/ogg'

      const recorder = new MediaRecorder(stream, { mimeType })
      audioChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data)
        }
      }

      recorder.onstop = async () => {
        // Stop all audio tracks to release the mic
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null

        const chunks = audioChunksRef.current
        if (chunks.length === 0) {
          setInterimTranscript('')
          return
        }

        setInterimTranscript('Processing...')

        try {
          const audioBlob = new Blob(chunks, { type: mimeType })
          const arrayBuffer = await audioBlob.arrayBuffer()

          const result = await window.brainwave.transcribeAudio(arrayBuffer, mimeType)

          if ('error' in result) {
            setError(result.error)
            setInterimTranscript('')
          } else if (result.text?.trim()) {
            onResultRef.current?.(result.text.trim())
            setInterimTranscript('')
          } else {
            setInterimTranscript('')
          }
        } catch (err) {
          console.error('[Voice] Transcription failed:', err)
          setError('Transcription failed — check your STT API key in Settings')
          setInterimTranscript('')
        }
      }

      recorder.onerror = () => {
        console.error('[Voice] MediaRecorder error')
        setError('Recording failed')
        setIsListening(false)
        setInterimTranscript('')
      }

      mediaRecorderRef.current = recorder
      recorder.start(250) // Collect chunks every 250ms
      setIsListening(true)
      setInterimTranscript('🎙️ Recording...')
    } catch (err) {
      console.error('[Voice] getUserMedia failed:', err)
      setError('Microphone access denied')
      setIsListening(false)
    }
  }, [])

  const stopListening = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
    mediaRecorderRef.current = null
    setIsListening(false)
  }, [])

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening()
    } else {
      startListening()
    }
  }, [isListening, startListening, stopListening])

  // ─── Text-to-Speech ─────────────────────────────────────

  const speak = useCallback(
    (text: string) => {
      if (!canSpeak) {
        setError('Speech synthesis not supported')
        return
      }

      // Stop any current speech
      window.speechSynthesis.cancel()

      // Strip markdown formatting for cleaner TTS
      const clean = text
        .replace(/```[\s\S]*?```/g, ' code block omitted ')
        .replace(/[#*_`~\[\]()]/g, '')
        .replace(/\n{2,}/g, '. ')
        .replace(/\n/g, ' ')
        .trim()

      if (!clean) return

      const utterance = new SpeechSynthesisUtterance(clean)
      utterance.lang = lang
      utterance.rate = 1.0
      utterance.pitch = 1.0

      utterance.onstart = () => setIsSpeaking(true)
      utterance.onend = () => setIsSpeaking(false)
      utterance.onerror = () => setIsSpeaking(false)

      window.speechSynthesis.speak(utterance)
    },
    [canSpeak, lang]
  )

  const stopSpeaking = useCallback(() => {
    if (canSpeak) {
      window.speechSynthesis.cancel()
      setIsSpeaking(false)
    }
  }, [canSpeak])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Stop recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop()
      }
      // Release mic
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
      }
      // Stop TTS
      if (canSpeak) {
        window.speechSynthesis.cancel()
      }
    }
  }, [canSpeak])

  return {
    isListening,
    isSpeaking,
    canListen,
    canSpeak,
    interimTranscript,
    error,
    startListening,
    stopListening,
    toggleListening,
    speak,
    stopSpeaking,
  }
}
