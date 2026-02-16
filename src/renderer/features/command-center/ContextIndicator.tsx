import { Brain, Zap } from 'lucide-react'

export interface ContextUsageData {
  taskId: string
  agentType: string
  tokensUsed: number
  budgetTotal: number
  usagePercent: number
  messageCount: number
  condensations: number
  step: number
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function getUsageColor(percent: number): { bar: string; text: string; bg: string } {
  if (percent >= 85) return { bar: 'bg-red-500', text: 'text-red-400', bg: 'bg-red-500/10' }
  if (percent >= 70) return { bar: 'bg-amber-500', text: 'text-amber-400', bg: 'bg-amber-500/10' }
  if (percent >= 50) return { bar: 'bg-yellow-500', text: 'text-yellow-400', bg: 'bg-yellow-500/5' }
  return { bar: 'bg-emerald-500', text: 'text-emerald-400', bg: 'bg-emerald-500/5' }
}

export function ContextIndicator({ data }: { data: ContextUsageData }) {
  const colors = getUsageColor(data.usagePercent)

  return (
    <div className={`flex items-center gap-2 px-2.5 py-1 rounded-md ${colors.bg} border border-white/[0.04]`}>
      {/* Icon */}
      <Brain className={`w-3 h-3 flex-shrink-0 ${colors.text} opacity-70`} />

      {/* Progress bar */}
      <div className="flex-1 h-1.5 bg-white/[0.06] rounded-full overflow-hidden min-w-[60px] max-w-[120px]">
        <div
          className={`h-full ${colors.bar} rounded-full transition-all duration-700 ease-out`}
          style={{ width: `${Math.min(100, data.usagePercent)}%` }}
        />
      </div>

      {/* Tokens text */}
      <span className={`text-[9px] font-mono flex-shrink-0 ${colors.text} opacity-80`}>
        {formatTokens(data.tokensUsed)} / {formatTokens(data.budgetTotal)}
      </span>

      {/* Percentage */}
      <span className={`text-[9px] font-mono flex-shrink-0 ${colors.text}`}>
        {Math.round(data.usagePercent)}%
      </span>

      {/* Condensation indicator */}
      {data.condensations > 0 && (
        <span className="flex items-center gap-0.5 text-[9px] text-purple-400/70" title={`${data.condensations} context condensation${data.condensations > 1 ? 's' : ''}`}>
          <Zap className="w-2.5 h-2.5" />
          {data.condensations}
        </span>
      )}
    </div>
  )
}
