import { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { Activity, Zap, Loader2 } from 'lucide-react'

// Map routes to page titles
const PAGE_TITLES: Record<string, string> = {
  '/': 'Command Center',
  '/agents': 'Agent Monitor',
  '/plan': 'Plan Board',
  '/scheduler': 'Scheduler',
  '/memory': 'Memory Palace',
  '/reflection': 'Reflection Journal',
  '/settings': 'Settings',
}

type SystemState = 'idle' | 'working' | 'error'

export function TopBar() {
  const location = useLocation()
  const title = PAGE_TITLES[location.pathname] ?? 'Brainwave'

  const [systemState, setSystemState] = useState<SystemState>('idle')
  const [activeCount, setActiveCount] = useState(0)
  const [llmConnected, setLlmConnected] = useState(false)

  // Poll agent status every 2s
  useEffect(() => {
    let mounted = true

    const poll = async () => {
      try {
        const statuses = await window.brainwave.getAgentStatus()
        if (!mounted) return

        const working = statuses.filter(
          (s: { state: string }) => s.state === 'thinking' || s.state === 'acting'
        )
        setActiveCount(working.length)
        setSystemState(working.length > 0 ? 'working' : 'idle')
        setLlmConnected(true)
      } catch {
        if (!mounted) return
        setSystemState('error')
        setLlmConnected(false)
      }
    }

    poll()
    const interval = setInterval(poll, 2000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  // Also listen for real-time task updates to react faster
  useEffect(() => {
    const unsub = window.brainwave.onTaskUpdate((update) => {
      if (update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled') {
        // Re-check shortly — agents may now be idle
        setTimeout(async () => {
          try {
            const statuses = await window.brainwave.getAgentStatus()
            const working = statuses.filter(
              (s: { state: string }) => s.state === 'thinking' || s.state === 'acting'
            )
            setActiveCount(working.length)
            setSystemState(working.length > 0 ? 'working' : 'idle')
          } catch { /* ignore */ }
        }, 500)
      } else if (update.status === 'planning' || update.status === 'executing') {
        setSystemState('working')
      }
    })
    return unsub
  }, [])

  const stateConfig = {
    idle: { label: 'System Idle', color: 'text-status-success', icon: Activity, animate: false },
    working: { label: `${activeCount} Agent${activeCount !== 1 ? 's' : ''} Working`, color: 'text-accent', icon: Loader2, animate: true },
    error: { label: 'System Error', color: 'text-red-400', icon: Activity, animate: false },
  }

  const { label, color, icon: StateIcon, animate } = stateConfig[systemState]

  return (
    <header className="flex items-center justify-between h-14 px-6 border-b border-white/[0.06] bg-surface-dark/50 backdrop-blur-sm">
      {/* Page title */}
      <h1 className="text-lg font-semibold text-white">{title}</h1>

      {/* Status indicators */}
      <div className="flex items-center gap-4">
        {/* Agent activity */}
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <StateIcon className={`w-4 h-4 ${color} ${animate ? 'animate-spin' : ''}`} />
          <span>{label}</span>
        </div>

        {/* Connection status */}
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.03] border ${
          llmConnected ? 'border-white/[0.06]' : 'border-red-400/30'
        }`}>
          <Zap className={`w-3.5 h-3.5 ${llmConnected ? 'text-accent' : 'text-red-400'}`} />
          <span className={`text-xs ${llmConnected ? 'text-gray-400' : 'text-red-400'}`}>
            {llmConnected ? 'Ready' : 'Disconnected'}
          </span>
        </div>
      </div>
    </header>
  )
}
