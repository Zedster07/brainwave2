/**
 * AgentStatusIndicator — Animated status pill showing current agent activity.
 *
 * Renders a compact pill with an activity-specific icon and label.
 * Active states get a spinning/pulsing animation to convey progress.
 */

import {
  Brain,
  Eye,
  Search,
  Pencil,
  Terminal,
  GitBranch,
  CheckCircle,
  AlertTriangle,
  Loader2,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import type { AgentActivity } from './chat-types'

interface AgentStatusIndicatorProps {
  activity: AgentActivity
  /** Compact mode — icon only, no label */
  compact?: boolean
  className?: string
}

type ActivityMeta = {
  icon: LucideIcon
  label: string
  color: string        // Tailwind text color
  bgColor: string      // Tailwind background
  animate: boolean     // Whether to spin/pulse
}

const ACTIVITY_MAP: Record<AgentActivity, ActivityMeta> = {
  idle:       { icon: Sparkles,      label: 'Idle',        color: 'text-gray-400',    bgColor: 'bg-gray-500/10',    animate: false },
  thinking:   { icon: Brain,         label: 'Thinking',    color: 'text-purple-400',  bgColor: 'bg-purple-500/10',  animate: true  },
  reasoning:  { icon: Brain,         label: 'Reasoning',   color: 'text-purple-400',  bgColor: 'bg-purple-500/10',  animate: true  },
  reading:    { icon: Eye,           label: 'Reading',     color: 'text-blue-400',    bgColor: 'bg-blue-500/10',    animate: true  },
  searching:  { icon: Search,        label: 'Searching',   color: 'text-cyan-400',    bgColor: 'bg-cyan-500/10',    animate: true  },
  writing:    { icon: Pencil,        label: 'Writing',     color: 'text-emerald-400', bgColor: 'bg-emerald-500/10', animate: true  },
  editing:    { icon: Pencil,        label: 'Editing',     color: 'text-emerald-400', bgColor: 'bg-emerald-500/10', animate: true  },
  executing:  { icon: Terminal,      label: 'Executing',   color: 'text-amber-400',   bgColor: 'bg-amber-500/10',   animate: true  },
  delegating: { icon: GitBranch,     label: 'Delegating',  color: 'text-violet-400',  bgColor: 'bg-violet-500/10',  animate: true  },
  evaluating: { icon: Loader2,       label: 'Evaluating',  color: 'text-indigo-400',  bgColor: 'bg-indigo-500/10',  animate: true  },
  completed:  { icon: CheckCircle,   label: 'Completed',   color: 'text-green-400',   bgColor: 'bg-green-500/10',   animate: false },
  error:      { icon: AlertTriangle, label: 'Error',       color: 'text-red-400',     bgColor: 'bg-red-500/10',     animate: false },
}

export function AgentStatusIndicator({ activity, compact, className = '' }: AgentStatusIndicatorProps) {
  const meta = ACTIVITY_MAP[activity]
  const Icon = meta.icon

  if (activity === 'idle') return null

  return (
    <span
      className={`
        inline-flex items-center gap-1.5 rounded-full
        ${meta.bgColor} ${meta.color}
        ${compact ? 'p-1' : 'px-2.5 py-1'}
        text-[11px] font-medium leading-none
        transition-all duration-300
        ${className}
      `}
    >
      <Icon
        className={`
          w-3 h-3 flex-shrink-0
          ${meta.animate ? 'animate-spin-slow' : ''}
        `}
      />
      {!compact && <span>{meta.label}</span>}
    </span>
  )
}
