/**
 * useVoice — Browser-based voice input/output using Web Speech API
 *
 * Provides speech-to-text (SpeechRecognition) for voice input
 * and text-to-speech (SpeechSynthesis) for reading responses aloud.
 *
 * Works entirely in the renderer — no main process involvement needed.
 */
import { useState, useCallback, useRef, useEffect } from 'react'

// ─── Types ──────────────────────────────────────────────────

interface VoiceState {
  /** Whether voice input is currently listening */
  isListening: boolean
  /** Whether TTS is currently speaking */
  isSpeaking: boolean
  /** Whether the browser supports speech recognition */
  canListen: boolean
  /** Whether the browser supports speech synthesis */
  canSpeak: boolean
  /** The current interim transcript (while still listening) */
  interimTranscript: string
  /** Error message if something went wrong */
  error: string | null
}

interface VoiceActions {
  /** Start listening for voice input */
  startListening: () => void
  /** Stop listening */
  stopListening: () => void
  /** Toggle listening on/off */
  toggleListening: () => void
  /** Speak text aloud using TTS */
  speak: (text: string) => void
  /** Stop speaking */
  stopSpeaking: () => void
}

interface UseVoiceOptions {
  /** Called with the final transcript when speech recognition completes */
  onResult?: (transcript: string) => void
  /** Language for recognition (default: 'en-US') */
  lang?: string
  /** Whether to use continuous recognition (default: false — stops after silence) */
  continuous?: boolean
}

// ─── SpeechRecognition Polyfill Types ───────────────────────

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList
  resultIndex: number
}

// ─── Hook ───────────────────────────────────────────────────

export function useVoice(options: UseVoiceOptions = {}): VoiceState & VoiceActions {
  const { onResult, lang = 'en-US', continuous = false } = options

  // Browser capabilities — resolve once and store in a ref to avoid re-renders
  const speechRecognitionRef = useRef(
    (window as unknown as { SpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition ??
    null
  )

  const canListen = !!speechRecognitionRef.current
  const canSpeak = 'speechSynthesis' in window

  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [interimTranscript, setInterimTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)

  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const onResultRef = useRef(onResult)

  // Keep the callback ref up-to-date without re-creating recognition
  useEffect(() => {
    onResultRef.current = onResult
  }, [onResult])

  const startListening = useCallback(() => {
    const SpeechRecognitionClass = speechRecognitionRef.current
    if (!SpeechRecognitionClass) {
      setError('Speech recognition not supported in this browser')
      return
    }

    // Clean up existing instance (stop gracefully, don't abort)
    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch { /* ignore */ }
      recognitionRef.current = null
    }

    const recognition = new SpeechRecognitionClass()
    recognition.lang = lang
    recognition.continuous = continuous
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      setIsListening(true)
      setError(null)
      setInterimTranscript('')
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      let final = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          final += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }

      setInterimTranscript(interim)

      if (final) {
        onResultRef.current?.(final.trim())
        setInterimTranscript('')
      }
    }

    recognition.onerror = (event: { error: string }) => {
      console.warn('[Voice] SpeechRecognition error:', event.error)
      // 'aborted' and 'no-speech' are not real errors
      if (event.error === 'aborted' || event.error === 'no-speech') {
        setIsListening(false)
        return
      }
      setError(`Speech error: ${event.error}`)
      setIsListening(false)
    }

    recognition.onend = () => {
      setIsListening(false)
      setInterimTranscript('')
    }

    recognitionRef.current = recognition
    recognition.start()
  }, [lang, continuous])

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
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
      if (recognitionRef.current) {
        recognitionRef.current.abort()
      }
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
