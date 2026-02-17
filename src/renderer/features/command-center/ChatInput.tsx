/**
 * ChatInput — Sticky-bottom input form extracted from CommandCenter.
 *
 * Handles: text area with auto-resize, image/document attachments (drag-drop,
 * paste, file picker), mode selector pills, voice input, submit.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Send,
  Plus,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  X,
  ImageIcon,
  FileText,
} from 'lucide-react'
import { useVoice } from '../../hooks/useVoice'
import type {
  ImageAttachment,
  DocumentAttachment,
  ModeInfo,
} from '@shared/types'

// ─── Constants ───

const MAX_IMAGES = 5
const MAX_IMAGE_SIZE = 4 * 1024 * 1024 // 4MB
const SUPPORTED_DOC_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md', '.json']
const MAX_DOCS = 5
const MAX_DOC_SIZE = 20 * 1024 * 1024 // 20MB

// ─── Props ───

interface ChatInputProps {
  onSubmit: (prompt: string, images?: ImageAttachment[], documents?: DocumentAttachment[], mode?: string) => Promise<void>
  modes: ModeInfo[]
  selectedMode: string | undefined
  onModeChange: (mode: string | undefined) => void
  disabled?: boolean
}

// ─── Component ───

export function ChatInput({ onSubmit, modes, selectedMode, onModeChange, disabled }: ChatInputProps) {
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Images
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Documents
  const [attachedDocuments, setAttachedDocuments] = useState<DocumentAttachment[]>([])
  const [processingDocs, setProcessingDocs] = useState(false)
  const docInputRef = useRef<HTMLInputElement>(null)

  // Voice
  const voice = useVoice({
    onResult: (transcript) => setInput((prev) => (prev ? prev + ' ' : '') + transcript),
  })

  // Focus on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // ─── Image helpers ───

  const fileToImageAttachment = useCallback((file: File): Promise<ImageAttachment | null> => {
    return new Promise((resolve) => {
      if (!file.type.startsWith('image/')) { resolve(null); return }
      if (file.size > MAX_IMAGE_SIZE) { resolve(null); return }
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const base64 = dataUrl.split(',')[1]
        if (!base64) { resolve(null); return }
        resolve({ data: base64, mimeType: file.type, name: file.name })
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
  }, [])

  const addImages = useCallback(async (files: File[]) => {
    const remaining = MAX_IMAGES - attachedImages.length
    if (remaining <= 0) return
    const results = await Promise.all(files.slice(0, remaining).map(fileToImageAttachment))
    const valid = results.filter((r): r is ImageAttachment => r !== null)
    if (valid.length > 0)
      setAttachedImages((prev) => [...prev, ...valid].slice(0, MAX_IMAGES))
  }, [attachedImages.length, fileToImageAttachment])

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // ─── Document helpers ───

  const addDocuments = useCallback(async (files: File[]) => {
    const remaining = MAX_DOCS - attachedDocuments.length
    if (remaining <= 0) return
    setProcessingDocs(true)
    try {
      const results: DocumentAttachment[] = []
      for (const file of files.slice(0, remaining)) {
        const ext = '.' + file.name.split('.').pop()?.toLowerCase()
        if (!SUPPORTED_DOC_EXTENSIONS.includes(ext)) continue
        if (file.size > MAX_DOC_SIZE) continue

        const textExts = ['.csv', '.txt', '.md', '.json']
        if (textExts.includes(ext)) {
          const text = await file.text()
          results.push({ name: file.name, extension: ext, extractedText: text.slice(0, 400_000), sizeBytes: file.size })
        } else {
          // Binary — try to extract via Electron path
          const filePath = (file as any).path as string | undefined
          if (filePath && window.brainwave.extractDocumentText) {
            try {
              const extracted = await window.brainwave.extractDocumentText(filePath)
              results.push({
                name: file.name,
                extension: ext,
                extractedText: extracted?.text ?? `[Failed to extract text from ${file.name}]`,
                sizeBytes: extracted?.sizeBytes ?? file.size,
              })
            } catch {
              results.push({ name: file.name, extension: ext, extractedText: `[Extraction error for ${file.name}]`, sizeBytes: file.size })
            }
          } else {
            results.push({
              name: file.name,
              extension: ext,
              extractedText: `[Binary document: ${file.name} — use attach button for full text extraction]`,
              sizeBytes: file.size,
            })
          }
        }
      }
      if (results.length > 0)
        setAttachedDocuments((prev) => [...prev, ...results].slice(0, MAX_DOCS))
    } finally {
      setProcessingDocs(false)
    }
  }, [attachedDocuments.length])

  const removeDocument = useCallback((index: number) => {
    setAttachedDocuments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // ─── Submit ───

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if ((!input.trim() && attachedImages.length === 0 && attachedDocuments.length === 0) || submitting || disabled) return

    const prompt = input.trim()
    const images = attachedImages.length > 0 ? [...attachedImages] : undefined
    const documents = attachedDocuments.length > 0 ? [...attachedDocuments] : undefined

    setInput('')
    setAttachedImages([])
    setAttachedDocuments([])
    if (inputRef.current) inputRef.current.style.height = 'auto'
    setSubmitting(true)

    try {
      await onSubmit(prompt, images, documents, selectedMode)
    } finally {
      setSubmitting(false)
      inputRef.current?.focus()
    }
  }, [input, submitting, disabled, attachedImages, attachedDocuments, selectedMode, onSubmit])

  const isDisabled = submitting || disabled
  const hasContent = input.trim() || attachedImages.length > 0 || attachedDocuments.length > 0

  return (
    <div className="sticky bottom-0 z-10 pt-2 pb-4 px-4 bg-gradient-to-t from-primary via-primary to-transparent">
      <form
        onSubmit={handleSubmit}
        className="glass-card p-4"
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const allFiles = Array.from(e.dataTransfer.files)
          const imageFiles = allFiles.filter((f) => f.type.startsWith('image/'))
          const docFiles = allFiles.filter((f) => {
            const ext = '.' + f.name.split('.').pop()?.toLowerCase()
            return SUPPORTED_DOC_EXTENSIONS.includes(ext) && !f.type.startsWith('image/')
          })
          if (imageFiles.length > 0) addImages(imageFiles)
          if (docFiles.length > 0) addDocuments(docFiles)
        }}
      >
        {/* Voice interim */}
        {voice.isListening && voice.interimTranscript && (
          <div className="mb-2 px-3 py-1.5 text-xs text-gray-400 italic bg-white/[0.02] rounded-lg border border-white/[0.05] truncate">
            {voice.interimTranscript}…
          </div>
        )}

        {/* Image thumbnails */}
        {attachedImages.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {attachedImages.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={img.name || `Image ${i + 1}`}
                  className="w-16 h-16 rounded-lg object-cover border border-white/[0.1] bg-white/[0.03]"
                />
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500/90 text-white flex items-center justify-center
                             opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
                >
                  <X className="w-3 h-3" />
                </button>
                {img.name && (
                  <p className="text-[9px] text-gray-500 mt-0.5 truncate max-w-[64px] text-center">{img.name}</p>
                )}
              </div>
            ))}
            {attachedImages.length < MAX_IMAGES && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-16 h-16 rounded-lg border border-dashed border-white/[0.1] bg-white/[0.02]
                           flex items-center justify-center text-gray-500 hover:text-gray-300 hover:border-white/[0.2] transition-colors"
              >
                <Plus className="w-5 h-5" />
              </button>
            )}
          </div>
        )}

        {/* Hidden image input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || [])
            if (files.length > 0) addImages(files)
            e.target.value = ''
          }}
        />

        {/* Document chips */}
        {(attachedDocuments.length > 0 || processingDocs) && (
          <div className="mb-3 flex flex-wrap gap-2">
            {attachedDocuments.map((doc, i) => (
              <div key={i} className="relative group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.1]">
                <FileText className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
                <span className="text-xs text-gray-300 truncate max-w-[120px]">{doc.name}</span>
                <span className="text-[10px] text-gray-500">{(doc.sizeBytes / 1024).toFixed(0)}KB</span>
                <button
                  type="button"
                  onClick={() => removeDocument(i)}
                  className="ml-0.5 w-4 h-4 rounded-full bg-red-500/80 text-white flex items-center justify-center
                             opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
            {processingDocs && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Extracting text…
              </div>
            )}
          </div>
        )}

        {/* Hidden doc input */}
        <input
          ref={docInputRef}
          type="file"
          accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.json"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addDocuments(Array.from(e.target.files))
            e.target.value = ''
          }}
        />

        {/* Mode pills */}
        {modes.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => onModeChange(undefined)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all
                ${!selectedMode
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'bg-white/[0.04] text-gray-400 border border-white/[0.08] hover:text-white hover:border-white/20'
                }`}
            >
              🎯 Auto
            </button>
            {modes.filter((m) => m.slug !== 'orchestrator').map((m) => (
              <button
                key={m.slug}
                type="button"
                onClick={() => onModeChange(m.slug === selectedMode ? undefined : m.slug)}
                title={m.description}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all
                  ${selectedMode === m.slug
                    ? 'bg-accent/20 text-accent border border-accent/40'
                    : 'bg-white/[0.04] text-gray-400 border border-white/[0.08] hover:text-white hover:border-white/20'
                  }`}
              >
                {m.icon ? `${m.icon} ` : ''}{m.name}
              </button>
            ))}
          </div>
        )}

        {/* Input row */}
        <div className="flex gap-3">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (hasContent && !isDisabled)
                  handleSubmit(e as unknown as React.FormEvent)
              }
            }}
            onPaste={(e) => {
              const items = Array.from(e.clipboardData?.items || [])
              const imageFiles = items
                .filter((item) => item.type.startsWith('image/'))
                .map((item) => item.getAsFile())
                .filter((f): f is File => f !== null)
              if (imageFiles.length > 0) {
                e.preventDefault()
                addImages(imageFiles)
              }
            }}
            placeholder={
              voice.isListening
                ? 'Listening...'
                : (attachedImages.length > 0 || attachedDocuments.length > 0)
                  ? 'Add a message or just send the attachment(s)...'
                  : 'e.g., Build a REST API for user authentication...'
            }
            disabled={isDisabled}
            rows={1}
            className="flex-1 bg-white/[0.03] border border-white/[0.08] rounded-lg px-4 py-3 text-sm text-white
                       placeholder:text-gray-600 focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20
                       disabled:opacity-50 transition-all resize-none overflow-hidden"
            style={{ minHeight: '44px', maxHeight: '160px', height: 'auto' }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement
              target.style.height = 'auto'
              target.style.height = `${Math.min(target.scrollHeight, 160)}px`
            }}
          />

          {/* Image attach */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isDisabled || attachedImages.length >= MAX_IMAGES}
            title={attachedImages.length >= MAX_IMAGES ? `Max ${MAX_IMAGES} images` : 'Attach image(s)'}
            className="flex items-center justify-center w-11 rounded-lg border transition-all
              bg-white/[0.03] border-white/[0.08] text-gray-400 hover:text-white hover:border-white/20
              disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ImageIcon className="w-4 h-4" />
          </button>

          {/* Doc attach */}
          <button
            type="button"
            onClick={() => docInputRef.current?.click()}
            disabled={isDisabled || attachedDocuments.length >= MAX_DOCS || processingDocs}
            title={attachedDocuments.length >= MAX_DOCS ? `Max ${MAX_DOCS} documents` : 'Attach document(s)'}
            className="flex items-center justify-center w-11 rounded-lg border transition-all
              bg-white/[0.03] border-white/[0.08] text-gray-400 hover:text-white hover:border-white/20
              disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Paperclip className="w-4 h-4" />
          </button>

          {/* Mic */}
          {voice.canListen && (
            <button
              type="button"
              onClick={voice.toggleListening}
              disabled={isDisabled}
              title={voice.isListening ? 'Stop listening' : 'Voice input'}
              className={`flex items-center justify-center w-11 rounded-lg border transition-all
                ${voice.isListening
                  ? 'bg-red-500/20 border-red-500/40 text-red-400 animate-pulse'
                  : 'bg-white/[0.03] border-white/[0.08] text-gray-400 hover:text-white hover:border-white/20'
                } disabled:opacity-30 disabled:cursor-not-allowed`}
            >
              {voice.isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={!hasContent || isDisabled}
            className="flex items-center gap-2 px-5 py-3 rounded-lg bg-accent text-white text-sm font-medium
                       hover:bg-accent/90 disabled:opacity-30 disabled:cursor-not-allowed
                       transition-all active:scale-[0.98]"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Submit
          </button>
        </div>

        <p className="text-[10px] text-gray-600 mt-2 text-center">
          Drag & drop files, or use <ImageIcon className="w-3 h-3 inline" /> for images and <Paperclip className="w-3 h-3 inline" /> for documents
        </p>
      </form>
    </div>
  )
}
