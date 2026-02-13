import { useEffect, useState, useCallback } from 'react'
import type { NotificationPayload } from '@shared/types'

const TYPE_STYLES: Record<string, { bg: string; border: string; icon: string }> = {
  task: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', icon: '✓' },
  scheduler: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', icon: '⏰' },
  agent: { bg: 'bg-purple-500/10', border: 'border-purple-500/30', icon: '🤖' },
  system: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', icon: 'ℹ' },
}

const TOAST_DURATION = 6000 // 6 seconds

export function NotificationToast() {
  const [toasts, setToasts] = useState<(NotificationPayload & { exiting?: boolean })[]>([])

  const dismiss = useCallback((id: string) => {
    // Mark as exiting for animation
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)))
    // Remove after animation
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 300)
  }, [])

  useEffect(() => {
    const cleanup = window.brainwave.onNotification((notification) => {
      setToasts((prev) => {
        // Cap at 5 toasts max
        const next = [...prev, notification]
        return next.length > 5 ? next.slice(-5) : next
      })

      // Auto-dismiss after duration
      setTimeout(() => dismiss(notification.id), TOAST_DURATION)
    })

    return cleanup
  }, [dismiss])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => {
        const style = TYPE_STYLES[toast.type] ?? TYPE_STYLES.system
        return (
          <div
            key={toast.id}
            className={`
              ${style.bg} ${style.border} border rounded-lg px-4 py-3
              backdrop-blur-md shadow-xl
              transition-all duration-300 ease-out
              ${toast.exiting ? 'opacity-0 translate-x-8' : 'opacity-100 translate-x-0 animate-slide-in'}
              cursor-pointer hover:brightness-125
            `}
            onClick={() => dismiss(toast.id)}
          >
            <div className="flex items-start gap-2">
              <span className="text-lg flex-shrink-0 mt-0.5">{style.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white truncate">{toast.title}</p>
                <p className="text-xs text-white/60 mt-0.5 line-clamp-2">{toast.body}</p>
              </div>
              <button
                className="text-white/40 hover:text-white/80 text-xs flex-shrink-0 ml-1"
                onClick={(e) => {
                  e.stopPropagation()
                  dismiss(toast.id)
                }}
              >
                ✕
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
