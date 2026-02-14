/**
 * Global Keyboard Shortcuts
 *
 * Ctrl+1-8  → Navigate to sidebar pages
 * Ctrl+B   → Toggle sidebar
 * Ctrl+,   → Settings
 * Ctrl+K   → Focus Command Center input
 * Escape   → Dismiss / blur active input
 */
import { useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUIStore } from '@renderer/stores/ui.store'

const NAV_ROUTES = [
  '/',            // Ctrl+1 — Command Center
  '/daily-pulse', // Ctrl+2 — Daily Pulse
  '/agents',      // Ctrl+3 — Agent Monitor
  '/plan',        // Ctrl+4 — Plan Board
  '/scheduler',   // Ctrl+5 — Scheduler
  '/memory',      // Ctrl+6 — Memory Palace
  '/graph',       // Ctrl+7 — Knowledge Graph
  '/reflection',  // Ctrl+8 — Reflection
  '/settings',    // Ctrl+9 — Settings
]

export function useKeyboardShortcuts(): void {
  const navigate = useNavigate()
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)

  const handler = useCallback(
    (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      const target = e.target as HTMLElement
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      // ── Escape — blur active input ──
      if (e.key === 'Escape' && isInput) {
        target.blur()
        return
      }

      // All remaining shortcuts require Ctrl/Cmd and should NOT fire inside inputs
      if (!ctrl) return
      if (isInput && e.key !== 'k') return // Allow Ctrl+K even in input

      // ── Ctrl+1-8 — Navigate ──
      const numKey = parseInt(e.key)
      if (numKey >= 1 && numKey <= 8) {
        e.preventDefault()
        navigate(NAV_ROUTES[numKey - 1])
        return
      }

      switch (e.key.toLowerCase()) {
        // ── Ctrl+B — Toggle sidebar ──
        case 'b':
          e.preventDefault()
          toggleSidebar()
          break

        // ── Ctrl+, — Settings ──
        case ',':
          e.preventDefault()
          navigate('/settings')
          break

        // ── Ctrl+K — Focus Command Center input ──
        case 'k':
          e.preventDefault()
          // Navigate to Command Center if not already there
          navigate('/')
          // Focus the textarea after a tick (to let the route render)
          requestAnimationFrame(() => {
            const textarea = document.querySelector<HTMLTextAreaElement>(
              'textarea[placeholder*="Ask"], textarea[placeholder*="prompt"], textarea[placeholder*="task"]'
            )
            textarea?.focus()
          })
          break
      }
    },
    [navigate, toggleSidebar]
  )

  useEffect(() => {
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handler])
}
