/**
 * Chat Types — Message-centric data model for the Copilot-style chat UI.
 *
 * Replaces the task-centric model with a proper conversation model.
 * Each "message" is either a user prompt or an assistant response.
 * Assistant responses contain structured content blocks (text, thinking,
 * tool calls, code diffs) that render as rich, interactive elements.
 */

import type {
  TaskStatus,
  TaskListItem,
  FollowupQuestion,
  ApprovalRequest,
  CheckpointInfo,
} from '@shared/types'
import type { ToolCallCardData } from './ToolCallCard'
import type { ContextUsageData } from './ContextIndicator'
import type { CostData } from './CostIndicator'

// ─── Agent Status ───

/** Fine-grained agent status for UI indicators */
export type AgentActivity =
  | 'idle'
  | 'thinking'       // LLM is processing
  | 'reasoning'      // Thinking/planning (interleaved thinking visible)
  | 'reading'        // Reading files
  | 'searching'      // Searching codebase
  | 'writing'        // Writing/creating files
  | 'editing'        // Editing files
  | 'executing'      // Running shell commands
  | 'delegating'     // Delegating to sub-agent
  | 'evaluating'     // Reviewing/evaluating results
  | 'completed'      // Done
  | 'error'          // Failed

// ─── Content Blocks ───

/** A thinking/reasoning block from the model's internal chain-of-thought */
export interface ThinkingBlockUI {
  type: 'thinking'
  content: string
  isStreaming: boolean
}

/** A text block — regular assistant prose */
export interface TextBlockUI {
  type: 'text'
  content: string
  isStreaming: boolean
}

/** A tool call block — represents a single tool invocation */
export interface ToolCallBlockUI {
  type: 'tool_call'
  data: ToolCallCardData
}

/** A code change block — file write/edit/create with optional diff */
export interface CodeChangeBlockUI {
  type: 'code_change'
  tool: 'file_write' | 'file_create' | 'file_edit' | 'apply_patch'
  filePath: string
  language: string
  content: string
  isStreaming: boolean
}

/** A status/progress update block */
export interface StatusBlockUI {
  type: 'status'
  activity: AgentActivity
  label: string
  detail?: string
}

/** A YouTube video/playlist embed block */
export interface YouTubeBlockUI {
  type: 'youtube'
  videoId: string
  title?: string
  /** If present, this is a playlist */
  playlistId?: string
  /** Start time in seconds */
  startAt?: number
}

/** Union of all renderable content blocks */
export type ContentBlockUI =
  | ThinkingBlockUI
  | TextBlockUI
  | ToolCallBlockUI
  | CodeChangeBlockUI
  | StatusBlockUI
  | YouTubeBlockUI

// ─── Messages ───

/** A user message in the chat */
export interface UserMessage {
  id: string
  role: 'user'
  content: string
  images?: Array<{ data: string; mimeType: string; name?: string }>
  documents?: Array<{ name: string; extension: string }>
  timestamp: number
}

/** An assistant message (response to a user message) */
export interface AssistantMessage {
  id: string
  role: 'assistant'
  /** The task ID this message corresponds to */
  taskId: string
  /** Structured content blocks (rendered in order) */
  blocks: ContentBlockUI[]
  /** Current agent activity for status indicator */
  activity: AgentActivity
  /** Accumulated plain text (for final result display) */
  plainText: string
  /** Task list (plan steps checklist) */
  taskList?: TaskListItem[]
  /** Active follow-up question */
  followupQuestion?: FollowupQuestion
  /** Active approval request */
  approvalRequest?: ApprovalRequest
  /** Checkpoints created */
  checkpoints?: CheckpointInfo[]
  /** Context usage stats */
  contextUsage?: ContextUsageData
  /** Cost info for this task */
  costInfo?: CostData
  /** Whether the response is still streaming */
  isStreaming: boolean
  /** Task status */
  status: TaskStatus
  /** Error message if failed */
  error?: string
  /** Final result output */
  result?: unknown
  timestamp: number
}

/** Union of all message types */
export type ChatMessage = UserMessage | AssistantMessage

// ─── Helpers ───

export function isUserMessage(msg: ChatMessage): msg is UserMessage {
  return msg.role === 'user'
}

export function isAssistantMessage(msg: ChatMessage): msg is AssistantMessage {
  return msg.role === 'assistant'
}

/** Infer agent activity from a step string (legacy activity log compatibility) */
export function inferActivity(step: string): AgentActivity {
  const lower = step.toLowerCase()
  if (lower.includes('reading') || lower.includes('file_read') || lower.includes('read_file')) return 'reading'
  if (lower.includes('searching') || lower.includes('grep') || lower.includes('search')) return 'searching'
  if (lower.includes('writing') || lower.includes('file_write') || lower.includes('file_create') || lower.includes('creating')) return 'writing'
  if (lower.includes('editing') || lower.includes('file_edit') || lower.includes('apply_patch') || lower.includes('patching')) return 'editing'
  if (lower.includes('executing') || lower.includes('shell') || lower.includes('running')) return 'executing'
  if (lower.includes('delegat') || lower.includes('subagent')) return 'delegating'
  if (lower.includes('evaluat') || lower.includes('review') || lower.includes('reflect')) return 'evaluating'
  if (lower.includes('thinking') || lower.includes('planning') || lower.includes('analyz')) return 'thinking'
  if (lower.startsWith('💭')) return 'reasoning'
  return 'thinking'
}

/** Get display label for an agent activity */
export function activityLabel(activity: AgentActivity): string {
  switch (activity) {
    case 'thinking': return 'Thinking...'
    case 'reasoning': return 'Reasoning...'
    case 'reading': return 'Reading files...'
    case 'searching': return 'Searching...'
    case 'writing': return 'Writing code...'
    case 'editing': return 'Editing files...'
    case 'executing': return 'Running command...'
    case 'delegating': return 'Delegating to agent...'
    case 'evaluating': return 'Evaluating...'
    case 'completed': return 'Done'
    case 'error': return 'Error'
    case 'idle': return ''
  }
}

/** Status → activity mapping */
export function statusToActivity(status: TaskStatus): AgentActivity {
  switch (status) {
    case 'queued': return 'idle'
    case 'planning': return 'thinking'
    case 'executing': return 'thinking'
    case 'completed': return 'completed'
    case 'failed': return 'error'
    case 'cancelled': return 'idle'
    default: return 'idle'
  }
}
