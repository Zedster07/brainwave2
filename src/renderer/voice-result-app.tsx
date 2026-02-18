import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { VoiceOverlayResultPayload } from '@shared/types'

function VoiceResultApp() {
  const [result, setResult] = useState<VoiceOverlayResultPayload | null>(null)
  const [visible, setVisible] = useState(false)
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    const unsub = window.voiceResult?.onResult((payload: VoiceOverlayResultPayload) => {
      setResult(payload)
      // Slide in after a tiny delay
      requestAnimationFrame(() => setVisible(true))
    })
    return () => unsub?.()
  }, [])

  const handleDismiss = () => {
    setExiting(true)
    setTimeout(() => {
      window.voiceResult?.dismiss()
    }, 300)
  }

  if (!result) return null

  const isSuccess = result.status === 'completed'

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'flex-start',
        padding: 12,
        background: 'transparent',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 380,
          background: 'rgba(15, 16, 22, 0.95)',
          backdropFilter: 'blur(20px)',
          borderRadius: 16,
          border: `1px solid ${isSuccess ? 'rgba(99, 102, 241, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
          boxShadow: `0 8px 32px rgba(0, 0, 0, 0.5), 0 0 60px ${isSuccess ? 'rgba(99, 102, 241, 0.1)' : 'rgba(239, 68, 68, 0.1)'}`,
          padding: 20,
          transform: visible && !exiting ? 'translateX(0)' : 'translateX(-120%)',
          opacity: visible && !exiting ? 1 : 0,
          transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Status dot */}
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: isSuccess ? '#6366f1' : '#ef4444',
              boxShadow: `0 0 8px ${isSuccess ? '#6366f1' : '#ef4444'}`,
            }} />
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              color: isSuccess ? '#a5b4fc' : '#fca5a5',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}>
              {isSuccess ? 'Task Complete' : 'Task Failed'}
            </span>
          </div>
          {/* Close button */}
          <button
            onClick={handleDismiss}
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              width: 28, height: 28,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'rgba(255,255,255,0.5)',
              fontSize: 14,
              transition: 'background 0.2s, color 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
              e.currentTarget.style.color = 'rgba(255,255,255,0.9)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
              e.currentTarget.style.color = 'rgba(255,255,255,0.5)'
            }}
          >
            ✕
          </button>
        </div>

        {/* Prompt (what user asked) */}
        <div style={{
          fontSize: 12,
          color: 'rgba(255,255,255,0.4)',
          marginBottom: 8,
          fontStyle: 'italic',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          "{result.prompt}"
        </div>

        {/* Decorative separator line */}
        <div style={{
          height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(99, 102, 241, 0.3), transparent)',
          marginBottom: 12,
        }} />

        {/* Result text */}
        <div style={{
          fontSize: 13,
          lineHeight: 1.6,
          color: 'rgba(255, 255, 255, 0.85)',
          maxHeight: 200,
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(99,102,241,0.3) transparent',
        }}>
          {result.result}
        </div>

        {/* Bottom accent line */}
        <div style={{
          marginTop: 16,
          height: 2,
          borderRadius: 1,
          background: isSuccess
            ? 'linear-gradient(90deg, #6366f1, #8b5cf6, transparent)'
            : 'linear-gradient(90deg, #ef4444, #f97316, transparent)',
        }} />
      </div>
    </div>
  )
}

// Mount
const root = createRoot(document.getElementById('root')!)
root.render(<VoiceResultApp />)
