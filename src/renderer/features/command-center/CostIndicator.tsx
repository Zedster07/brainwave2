/**
 * CostIndicator — Compact cost display pill for task messages.
 *
 * Shows total cost (USD), token breakdown, and run count.
 * Positioned alongside ContextIndicator in message footers.
 */

import { DollarSign } from 'lucide-react'

export interface CostData {
  taskId: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  runCount: number
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatCost(usd: number): string {
  if (usd < 0.001) return '<$0.001'
  if (usd < 0.01) return `$${usd.toFixed(3)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

function getCostColor(usd: number): { text: string; bg: string } {
  if (usd >= 0.50) return { text: 'text-red-400', bg: 'bg-red-500/10' }
  if (usd >= 0.10) return { text: 'text-amber-400', bg: 'bg-amber-500/10' }
  if (usd >= 0.01) return { text: 'text-yellow-400', bg: 'bg-yellow-500/5' }
  return { text: 'text-emerald-400', bg: 'bg-emerald-500/5' }
}

export function CostIndicator({ data }: { data: CostData }) {
  const colors = getCostColor(data.costUsd)
  const totalTokens = data.tokensIn + data.tokensOut

  return (
    <div
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md ${colors.bg} border border-white/[0.04]`}
      title={`In: ${data.tokensIn.toLocaleString()} · Out: ${data.tokensOut.toLocaleString()} · ${data.runCount} run${data.runCount !== 1 ? 's' : ''}`}
    >
      {/* Icon */}
      <DollarSign className={`w-3 h-3 flex-shrink-0 ${colors.text} opacity-70`} />

      {/* Cost */}
      <span className={`text-[9px] font-mono flex-shrink-0 ${colors.text}`}>
        {formatCost(data.costUsd)}
      </span>

      {/* Token count */}
      <span className={`text-[9px] font-mono flex-shrink-0 ${colors.text} opacity-60`}>
        {formatTokens(totalTokens)} tok
      </span>
    </div>
  )
}
