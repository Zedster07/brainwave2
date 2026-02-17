/**
 * ThinkingBlock — Collapsible thinking/reasoning section.
 *
 * Renders the model's internal chain-of-thought as an expandable
 * block with a subtle brain icon. Auto-collapsed by default,
 * with a short preview of the thinking content.
 */

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, ChevronRight, Brain } from 'lucide-react'

interface ThinkingBlockProps {
  content: string
  isStreaming: boolean
  /** Start collapsed by default. Auto-expand when streaming starts. */
  defaultExpanded?: boolean
}

export function ThinkingBlock({ content, isStreaming, defaultExpanded }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? isStreaming)
  const contentRef = useRef<HTMLDivElement>(null)

  // Auto-scroll during streaming
  useEffect(() => {
    if (isStreaming && expanded && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [content, isStreaming, expanded])

  // Auto-expand when streaming starts, auto-collapse when done
  useEffect(() => {
    if (isStreaming) setExpanded(true)
  }, [isStreaming])

  // Generate preview text (first line, cleaned up)
  const preview = content
    .split('\n')[0]
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, 120)

  const lineCount = content.split('\n').length

  if (!content.trim()) return null

  return (
    <div className="my-2 rounded-lg border border-purple-500/15 bg-purple-500/[0.03] overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-purple-500/[0.04] transition-colors group"
      >
        <span className="text-purple-400/60 flex-shrink-0">
          {expanded
            ? <ChevronDown className="w-3.5 h-3.5" />
            : <ChevronRight className="w-3.5 h-3.5" />
          }
        </span>

        <Brain className="w-3.5 h-3.5 text-purple-400/50 flex-shrink-0" />

        <span className="text-[11px] font-medium text-purple-300/70">
          Thinking
        </span>

        {isStreaming && (
          <span className="text-[10px] text-purple-400/50 animate-pulse">
            reasoning...
          </span>
        )}

        {!expanded && preview && (
          <span className="text-[10px] text-gray-500 truncate ml-1 flex-1">
            {preview}{preview.length >= 120 ? '...' : ''}
          </span>
        )}

        <span className="text-[9px] text-gray-600 flex-shrink-0 ml-auto">
          {lineCount} line{lineCount !== 1 ? 's' : ''}
        </span>
      </button>

      {/* Content — collapsible */}
      {expanded && (
        <div
          ref={contentRef}
          className="px-3 pb-3 max-h-[300px] overflow-y-auto"
        >
          <div className="text-[11px] leading-relaxed text-gray-400/80 whitespace-pre-wrap font-mono">
            {content}
            {isStreaming && (
              <span className="inline-block w-[5px] h-[12px] bg-purple-400/60 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
