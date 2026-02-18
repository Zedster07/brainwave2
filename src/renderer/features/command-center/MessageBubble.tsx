/**
 * MessageBubble — Renders a single chat message (user or assistant).
 *
 * User messages: right-aligned pill with text + optional image/doc badges.
 * Assistant messages: left-aligned block with structured content blocks:
 *   ThinkingBlock → Markdown text → ToolCallCards → CodeChangeBlocks
 *   → FollowupQuestion → ApprovalRequest → Result
 */

import { useState } from 'react'
import {
  User,
  Bot,
  Image as ImageIcon,
  FileText,
  Send,
  CheckCircle,
  XCircle,
  ShieldCheck,
  GitBranch,
  Copy,
  Check,
} from 'lucide-react'
import { Markdown } from '../../components/Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { AgentStatusIndicator } from './AgentStatusIndicator'
import { ToolCallCard } from './ToolCallCard'
import { ContextIndicator } from './ContextIndicator'
import { CostIndicator } from './CostIndicator'
import { StreamingContent } from './StreamingCodeCard'
import { YouTubePlayer } from './YouTubePlayer'
import type {
  ChatMessage,
  UserMessage,
  AssistantMessage,
  ContentBlockUI,
} from './chat-types'
import { isUserMessage, isAssistantMessage } from './chat-types'
import type { FollowupQuestion, ApprovalRequest, CheckpointInfo } from '@shared/types'

// ─── Sub-components ───

function UserBubble({ msg }: { msg: UserMessage }) {
  return (
    <div className="flex justify-end gap-2.5 group">
      <div className="max-w-[80%] flex flex-col items-end">
        {/* Attachments */}
        {((msg.images && msg.images.length > 0) || (msg.documents && msg.documents.length > 0)) && (
          <div className="flex flex-wrap gap-1.5 mb-1.5 justify-end">
            {msg.images?.map((img, i) => (
              <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent/10 text-accent text-[10px]">
                <ImageIcon className="w-3 h-3" />
                {img.name || 'Image'}
              </span>
            ))}
            {msg.documents?.map((doc, i) => (
              <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 text-[10px]">
                <FileText className="w-3 h-3" />
                {doc.name}
              </span>
            ))}
          </div>
        )}

        {/* Message bubble */}
        <div className="bg-accent/15 border border-accent/20 rounded-2xl rounded-br-md px-4 py-2.5">
          <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
            {msg.content}
          </p>
        </div>

        <span className="text-[9px] text-gray-600 mt-1 mr-1">
          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center flex-shrink-0 mt-0.5">
        <User className="w-3.5 h-3.5 text-accent" />
      </div>
    </div>
  )
}

/** Render a single content block */
function BlockRenderer({ block, index }: { block: ContentBlockUI; index: number }) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} isStreaming={block.isStreaming} />

    case 'text':
      return block.isStreaming ? (
        <div className="relative">
          <StreamingContent text={block.content} />
          <span className="inline-block w-[5px] h-[14px] bg-accent/60 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
        </div>
      ) : (
        <Markdown content={block.content} />
      )

    case 'tool_call':
      return <ToolCallCard data={block.data} index={index} />

    case 'code_change':
      return (
        <div className="my-2 rounded-lg border border-emerald-500/15 bg-emerald-500/[0.03] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-emerald-500/10">
            <FileText className="w-3 h-3 text-emerald-400/60" />
            <span className="text-[11px] text-emerald-400/80 font-mono truncate">{block.filePath}</span>
            {block.isStreaming && (
              <span className="text-[9px] text-emerald-400/40 animate-pulse">writing...</span>
            )}
          </div>
          <pre className="px-3 py-2 overflow-x-auto max-h-[300px] overflow-y-auto">
            <code className="text-[11px] text-gray-300 font-mono leading-relaxed">
              {block.content}
              {block.isStreaming && (
                <span className="inline-block w-[5px] h-[12px] bg-emerald-400/50 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
              )}
            </code>
          </pre>
        </div>
      )

    case 'status':
      return (
        <div className="flex items-center gap-2 py-0.5">
          <AgentStatusIndicator activity={block.activity} />
          {block.detail && (
            <span className="text-[10px] text-gray-500 truncate">{block.detail}</span>
          )}
        </div>
      )

    case 'youtube':
      return (
        <YouTubePlayer
          videoId={block.videoId}
          title={block.title}
          playlistId={block.playlistId}
          startAt={block.startAt}
        />
      )

    default:
      return null
  }
}

/** Follow-up question prompt */
function FollowupPrompt({
  question,
  onRespond,
}: {
  question: FollowupQuestion
  onRespond: (questionId: string, answer: string) => void
}) {
  const [input, setInput] = useState('')
  const hasOptions = question.options && question.options.length > 0

  return (
    <div className="my-3 p-3 rounded-lg border border-accent/20 bg-accent/[0.04]">
      <p className="text-sm text-gray-200 mb-2">{question.question}</p>

      {/* Option buttons */}
      {hasOptions && (
        <div className="flex flex-wrap gap-1.5">
          {question.options!.map((opt) => (
            <button
              key={opt}
              onClick={() => onRespond(question.questionId, opt)}
              className="px-3 py-1.5 rounded-md bg-accent/10 text-accent text-xs
                         hover:bg-accent/20 transition-colors border border-accent/20"
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {/* Custom answer input — always shown */}
      <div className={`flex gap-2 ${hasOptions ? 'mt-2' : ''}`}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim()) onRespond(question.questionId, input)
          }}
          className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-md px-3 py-1.5
                      text-sm text-gray-200 placeholder-gray-500 focus:border-accent/40
                      focus:outline-none"
          placeholder={hasOptions ? 'Or type a custom answer…' : 'Type your answer…'}
        />
        <button
          onClick={() => { if (input.trim()) onRespond(question.questionId, input) }}
          disabled={!input.trim()}
          className="p-1.5 rounded-md bg-accent/15 text-accent hover:bg-accent/25 transition-colors
                     disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

/** Approval request prompt */
function ApprovalPrompt({
  request,
  onApprove,
  onReject,
}: {
  request: ApprovalRequest
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  return (
    <div className="my-3 p-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.04]">
      <div className="flex items-start gap-2 mb-2">
        <ShieldCheck className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-amber-300">{request.tool}</p>
          <p className="text-xs text-gray-400 mt-0.5">{request.summary}</p>
        </div>
      </div>

      {request.args && (
        <pre className="text-[10px] text-gray-400 bg-white/[0.03] rounded px-2 py-1.5 mb-2 overflow-x-auto font-mono">
          {typeof request.args === 'string' ? request.args : JSON.stringify(request.args, null, 2)}
        </pre>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => onApprove(request.approvalId)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/15
                     text-emerald-400 text-xs hover:bg-emerald-500/25 transition-colors
                     border border-emerald-500/20"
        >
          <CheckCircle className="w-3.5 h-3.5" />
          Approve
        </button>
        <button
          onClick={() => onReject(request.approvalId)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-500/10
                     text-red-400 text-xs hover:bg-red-500/20 transition-colors
                     border border-red-500/20"
        >
          <XCircle className="w-3.5 h-3.5" />
          Reject
        </button>
      </div>
    </div>
  )
}

/** Checkpoint marker */
function CheckpointMarker({ checkpoint }: { checkpoint: CheckpointInfo }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[10px] text-gray-500">
      <div className="flex-1 h-px bg-white/[0.06]" />
      <GitBranch className="w-3 h-3 text-violet-400/50" />
      <span className="text-violet-400/60">
        Checkpoint #{checkpoint.step ?? 0}
      </span>
      <div className="flex-1 h-px bg-white/[0.06]" />
    </div>
  )
}

function AssistantBubble({
  msg,
  onFollowupRespond,
  onApprove,
  onReject,
}: {
  msg: AssistantMessage
  onFollowupRespond: (questionId: string, answer: string) => void
  onApprove: (approvalId: string) => void
  onReject: (approvalId: string) => void
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (msg.plainText) {
      navigator.clipboard.writeText(msg.plainText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="flex gap-2.5 group">
      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-accent/30 to-purple-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Bot className="w-3.5 h-3.5 text-accent" />
      </div>

      <div className="flex-1 min-w-0 max-w-[85%]">
        {/* Status indicator */}
        {msg.isStreaming && (
          <div className="mb-2">
            <AgentStatusIndicator activity={msg.activity} />
          </div>
        )}

        {/* Content blocks */}
        <div className="space-y-1">
          {msg.blocks.map((block, i) => (
            <BlockRenderer key={`${block.type}-${i}`} block={block} index={i} />
          ))}
        </div>

        {/* Checkpoints */}
        {msg.checkpoints && msg.checkpoints.length > 0 && (
          <div className="mt-1">
            {msg.checkpoints.map((cp) => (
              <CheckpointMarker key={`${cp.step}-${cp.createdAt}`} checkpoint={cp} />
            ))}
          </div>
        )}

        {/* Context usage */}
        {msg.contextUsage && (
          <div className="mt-2">
            <ContextIndicator data={msg.contextUsage} />
          </div>
        )}

        {/* Cost info */}
        {msg.costInfo && (
          <div className="mt-1">
            <CostIndicator data={msg.costInfo} />
          </div>
        )}

        {/* Follow-up question */}
        {msg.followupQuestion && (
          <FollowupPrompt
            question={msg.followupQuestion}
            onRespond={onFollowupRespond}
          />
        )}

        {/* Approval request */}
        {msg.approvalRequest && (
          <ApprovalPrompt
            request={msg.approvalRequest}
            onApprove={onApprove}
            onReject={onReject}
          />
        )}

        {/* Final result */}
        {msg.status === 'completed' && msg.result && !msg.isStreaming && (
          <div className="mt-2 p-3 rounded-lg border border-emerald-500/15 bg-emerald-500/[0.03]">
            <div className="flex items-center gap-1.5 mb-1">
              <CheckCircle className="w-3 h-3 text-emerald-400" />
              <span className="text-[11px] font-medium text-emerald-400">Result</span>
            </div>
            <Markdown content={String(msg.result)} />
          </div>
        )}

        {/* Error */}
        {msg.status === 'failed' && msg.error && (
          <div className="mt-2 p-3 rounded-lg border border-red-500/15 bg-red-500/[0.04]">
            <div className="flex items-center gap-1.5 mb-1">
              <XCircle className="w-3 h-3 text-red-400" />
              <span className="text-[11px] font-medium text-red-400">Error</span>
            </div>
            <p className="text-xs text-red-300/80">{msg.error}</p>
          </div>
        )}

        {/* Footer: timestamp + copy */}
        <div className="flex items-center gap-2 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <span className="text-[9px] text-gray-600">
            {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {!msg.isStreaming && msg.plainText && (
            <button
              onClick={handleCopy}
              className="p-0.5 rounded text-gray-500 hover:text-gray-300 transition-colors"
              title="Copy response"
            >
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main Export ───

interface MessageBubbleProps {
  message: ChatMessage
  onFollowupRespond: (questionId: string, answer: string) => void
  onApprove: (approvalId: string) => void
  onReject: (approvalId: string) => void
}

export function MessageBubble({ message, onFollowupRespond, onApprove, onReject }: MessageBubbleProps) {
  if (isUserMessage(message)) {
    return <UserBubble msg={message} />
  }

  if (isAssistantMessage(message)) {
    return (
      <AssistantBubble
        msg={message}
        onFollowupRespond={onFollowupRespond}
        onApprove={onApprove}
        onReject={onReject}
      />
    )
  }

  return null
}
