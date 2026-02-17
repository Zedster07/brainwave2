/**
 * ChatMessageList — Scrollable message container with auto-scroll.
 *
 * Renders ChatMessage[] as a vertical list of MessageBubble components.
 * Includes a welcome state for empty conversations and auto-scrolls
 * to the latest message during streaming.
 */

import { useRef, useEffect, useCallback } from 'react'
import { Sparkles } from 'lucide-react'
import { MessageBubble } from './MessageBubble'
import type { ChatMessage, AssistantMessage } from './chat-types'

interface ChatMessageListProps {
  messages: ChatMessage[]
  loaded: boolean
  onFollowupRespond: (questionId: string, answer: string) => void
  onApprove: (approvalId: string) => void
  onReject: (approvalId: string) => void
}

export function ChatMessageList({
  messages,
  loaded,
  onFollowupRespond,
  onApprove,
  onReject,
}: ChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    })
  }, [])

  // Auto-scroll when messages change — only if user hasn't scrolled up significantly
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    // Only auto-scroll if user is near the bottom (within 200px)
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200
    if (isNearBottom) scrollToBottom()
  }, [messages, scrollToBottom])

  // Determine if any assistant message is currently streaming
  const isStreaming = messages.some(
    (m) => m.role === 'assistant' && (m as AssistantMessage).isStreaming
  )

  // Auto-scroll on every render tick while streaming
  useEffect(() => {
    if (!isStreaming) return
    const interval = setInterval(scrollToBottom, 300)
    return () => clearInterval(interval)
  }, [isStreaming, scrollToBottom])

  if (!loaded) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <div className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          Loading conversation...
        </div>
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-8">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-accent/20 to-purple-500/20 flex items-center justify-center mx-auto mb-4">
            <Sparkles className="w-7 h-7 text-accent" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-1">Start a conversation</h3>
          <p className="text-sm text-gray-500 leading-relaxed">
            Describe a task, ask a question, or attach files. The agent will plan, execute,
            and show its work in real time.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-6 scroll-smooth">
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          onFollowupRespond={onFollowupRespond}
          onApprove={onApprove}
          onReject={onReject}
        />
      ))}

      {/* Bottom spacer for sticky input clearance */}
      <div className="h-4" />
    </div>
  )
}
