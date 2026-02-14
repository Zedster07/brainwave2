import { useLocation, useNavigate } from 'react-router-dom'
import {
  Brain,
  Terminal,
  Network,
  LayoutDashboard,
  BookOpen,
  Settings,
  ChevronLeft,
  ChevronRight,
  Clock,
  GitBranch,
  Sun,
} from 'lucide-react'
import { useUIStore } from '@renderer/stores/ui.store'

const NAV_ITEMS = [
  { path: '/', label: 'Command Center', icon: Terminal, section: 'main' },
  { path: '/daily-pulse', label: 'Daily Pulse', icon: Sun, section: 'main' },
  { path: '/agents', label: 'Agent Monitor', icon: Network, section: 'main' },
  { path: '/plan', label: 'Plan Board', icon: LayoutDashboard, section: 'main' },
  { path: '/scheduler', label: 'Scheduler', icon: Clock, section: 'main' },
  { path: '/memory', label: 'Memory Palace', icon: Brain, section: 'insights' },
  { path: '/graph', label: 'Knowledge Graph', icon: GitBranch, section: 'insights' },
  { path: '/reflection', label: 'Reflection', icon: BookOpen, section: 'insights' },
  { path: '/settings', label: 'Settings', icon: Settings, section: 'system' },
] as const

export function Sidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { sidebarCollapsed, toggleSidebar } = useUIStore()

  const mainItems = NAV_ITEMS.filter((i) => i.section === 'main')
  const insightItems = NAV_ITEMS.filter((i) => i.section === 'insights')
  const systemItems = NAV_ITEMS.filter((i) => i.section === 'system')

  return (
    <aside
      className={`
        flex flex-col h-full glass-surface bg-surface-dark/80 border-r
        transition-all duration-300 ease-out
        ${sidebarCollapsed ? 'w-16' : 'w-56'}
      `}
    >
      {/* Logo area */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-white/[0.06]">
        <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center flex-shrink-0">
          <Brain className="w-5 h-5 text-accent" />
        </div>
        {!sidebarCollapsed && (
          <span className="text-sm font-semibold text-white truncate animate-fade-in">
            Brainwave 2
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-2 space-y-1 overflow-y-auto">
        {/* Main section */}
        <NavSection label="Control" collapsed={sidebarCollapsed} items={mainItems} currentPath={location.pathname} onNavigate={navigate} />

        {/* Divider */}
        <div className="!my-3 border-t border-white/[0.04]" />

        {/* Insights */}
        <NavSection label="Insights" collapsed={sidebarCollapsed} items={insightItems} currentPath={location.pathname} onNavigate={navigate} />

        {/* Divider */}
        <div className="!my-3 border-t border-white/[0.04]" />

        {/* System */}
        <NavSection label="System" collapsed={sidebarCollapsed} items={systemItems} currentPath={location.pathname} onNavigate={navigate} />
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={toggleSidebar}
        className="flex items-center justify-center h-10 border-t border-white/[0.06] text-gray-500 hover:text-gray-300 transition-colors"
        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
      </button>
    </aside>
  )
}

// ─── Sub-components ───

interface NavSectionProps {
  label: string
  collapsed: boolean
  items: readonly (typeof NAV_ITEMS)[number][]
  currentPath: string
  onNavigate: (path: string) => void
}

function NavSection({ label, collapsed, items, currentPath, onNavigate }: NavSectionProps) {
  return (
    <div>
      {!collapsed && (
        <p className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600">
          {label}
        </p>
      )}
      {items.map((item) => {
        const isActive = currentPath === item.path
        const Icon = item.icon
        return (
          <button
            key={item.path}
            onClick={() => onNavigate(item.path)}
            title={collapsed ? item.label : undefined}
            className={`
              flex items-center gap-3 w-full rounded-lg px-3 py-2 text-sm
              transition-all duration-150
              ${isActive
                ? 'bg-accent/10 text-accent glow-subtle'
                : 'text-gray-400 hover:bg-white/[0.04] hover:text-gray-200'
              }
              ${collapsed ? 'justify-center px-0' : ''}
            `}
          >
            <Icon className={`w-[18px] h-[18px] flex-shrink-0 ${isActive ? 'text-accent' : ''}`} />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </button>
        )
      })}
    </div>
  )
}
