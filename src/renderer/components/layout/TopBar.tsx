import { useLocation } from 'react-router-dom'
import { Activity, Zap } from 'lucide-react'

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

export function TopBar() {
  const location = useLocation()
  const title = PAGE_TITLES[location.pathname] ?? 'Brainwave'

  return (
    <header className="flex items-center justify-between h-14 px-6 border-b border-white/[0.06] bg-surface-dark/50 backdrop-blur-sm">
      {/* Page title */}
      <h1 className="text-lg font-semibold text-white">{title}</h1>

      {/* Status indicators */}
      <div className="flex items-center gap-4">
        {/* Agent activity */}
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Activity className="w-4 h-4 text-status-success" />
          <span>System Idle</span>
        </div>

        {/* Connection status */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.03] border border-white/[0.06]">
          <Zap className="w-3.5 h-3.5 text-accent" />
          <span className="text-xs text-gray-400">Ready</span>
        </div>
      </div>
    </header>
  )
}
