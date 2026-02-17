/**
 * Chat Store — Centralized state management for the command center.
 *
 * Uses Zustand for global chat state so any component in the tree
 * can access messages, sessions, and streaming state.
 *
 * Handles all IPC event subscriptions centrally, replacing the
 * 8+ inline useEffect hooks from the old CommandCenter monolith.
 */

import { create } from 'zustand'
import type {
  TaskUpdate,
  StreamChunk,
  FollowupQuestion,
  ApprovalRequest,
  CheckpointInfo,
  ContextUsageInfo,
  ToolCallInfo,
  ChatSession,
  ModeInfo,
  YouTubePlayPayload,
} from '@shared/types'
import type { ToolCallCardData } from './ToolCallCard'
import type { ContextUsageData } from './ContextIndicator'
import type {
  ChatMessage,
  AssistantMessage,
  UserMessage,
  AgentActivity,
  ContentBlockUI,
} from './chat-types'
import { statusToActivity, inferActivity } from './chat-types'

interface ChatStore {
  // ─── Session State ───
  sessions: ChatSession[]
  autoSessions: ChatSession[]
  activeSessionId: string | null
  sidebarOpen: boolean
  sidebarTab: 'user' | 'autonomous'

  // ─── Messages ───
  messages: ChatMessage[]
  loaded: boolean

  // ─── Modes ───
  modes: ModeInfo[]
  selectedMode: string | undefined

  // ─── Actions: Sessions ───
  setSessions: (sessions: ChatSession[]) => void
  setAutoSessions: (sessions: ChatSession[]) => void
  setActiveSessionId: (id: string | null) => void
  addSession: (session: ChatSession) => void
  removeSession: (id: string) => void
  updateSessionTitle: (id: string, title: string) => void
  setSidebarOpen: (open: boolean) => void
  setSidebarTab: (tab: 'user' | 'autonomous') => void

  // ─── Actions: Messages ───
  setMessages: (messages: ChatMessage[]) => void
  setLoaded: (loaded: boolean) => void
  addUserMessage: (msg: UserMessage) => void
  addAssistantMessage: (msg: AssistantMessage) => void

  // ─── Actions: Event Handlers (called by IPC subscriptions) ───
  handleTaskUpdate: (update: TaskUpdate) => void
  handleStreamChunk: (chunk: StreamChunk) => void
  handleFollowupQuestion: (question: FollowupQuestion) => void
  clearFollowupQuestion: (questionId: string) => void
  handleApprovalRequest: (request: ApprovalRequest) => void
  clearApprovalRequest: (approvalId: string) => void
  handleCheckpoint: (checkpoint: CheckpointInfo) => void
  handleToolCallInfo: (info: ToolCallInfo) => void
  handleContextUsage: (usage: ContextUsageInfo) => void
  handleYouTubePlay: (payload: YouTubePlayPayload) => void

  // ─── Actions: Modes ───
  setModes: (modes: ModeInfo[]) => void
  setSelectedMode: (mode: string | undefined) => void

  // ─── Helpers ───
  getActiveAssistantMessage: () => AssistantMessage | undefined
  findAssistantByTaskId: (taskId: string) => AssistantMessage | undefined
}

/** Find the assistant message matching a taskId */
function findByTaskId(messages: ChatMessage[], taskId: string): number {
  return messages.findIndex(
    (m) => m.role === 'assistant' && (m as AssistantMessage).taskId === taskId,
  )
}

/** Update an assistant message immutably */
function updateAssistant(
  messages: ChatMessage[],
  taskId: string,
  updater: (msg: AssistantMessage) => AssistantMessage,
): ChatMessage[] {
  const idx = findByTaskId(messages, taskId)
  if (idx === -1) return messages
  const updated = [...messages]
  updated[idx] = updater(updated[idx] as AssistantMessage)
  return updated
}

export const useChatStore = create<ChatStore>((set, get) => ({
  // ─── Initial State ───
  sessions: [],
  autoSessions: [],
  activeSessionId: null,
  sidebarOpen: true,
  sidebarTab: 'user',
  messages: [],
  loaded: false,
  modes: [],
  selectedMode: undefined,

  // ─── Session Actions ───
  setSessions: (sessions) => set({ sessions }),
  setAutoSessions: (sessions) => set({ autoSessions: sessions }),
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  addSession: (session) =>
    set((s) =>
      session.type === 'autonomous'
        ? { autoSessions: [session, ...s.autoSessions] }
        : { sessions: [session, ...s.sessions] },
    ),
  removeSession: (id) =>
    set((s) => ({
      sessions: s.sessions.filter((sess) => sess.id !== id),
      autoSessions: s.autoSessions.filter((sess) => sess.id !== id),
      ...(s.activeSessionId === id ? { activeSessionId: null, messages: [] } : {}),
    })),
  updateSessionTitle: (id, title) =>
    set((s) => ({
      sessions: s.sessions.map((sess) => (sess.id === id ? { ...sess, title } : sess)),
      autoSessions: s.autoSessions.map((sess) => (sess.id === id ? { ...sess, title } : sess)),
    })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),

  // ─── Message Actions ───
  setMessages: (messages) => set({ messages }),
  setLoaded: (loaded) => set({ loaded }),
  addUserMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  addAssistantMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),

  // ─── Event Handlers ───

  handleTaskUpdate: (update) =>
    set((s) => {
      const updated = updateAssistant(s.messages, update.taskId, (msg) => {
        const newBlocks = [...msg.blocks]

        // Infer live activity from the step string (used for the header indicator)
        const liveActivity = update.currentStep
          ? inferActivity(update.currentStep)
          : statusToActivity(update.status)

        // Determine final activity — completed/failed overrides any live activity
        const finalActivity = update.status === 'completed'
          ? 'completed' as const
          : update.status === 'failed'
            ? 'error' as const
            : liveActivity

        // NOTE: We intentionally do NOT add status blocks here.
        // The AssistantBubble header shows `AgentStatusIndicator`
        // driven by `msg.activity`, which gives real-time status
        // without cluttering the content with redundant "Thinking" pills.

        return {
          ...msg,
          status: update.status,
          activity: finalActivity,
          result: update.result ?? msg.result,
          error: update.error ?? msg.error,
          isStreaming: update.status === 'executing' || update.status === 'planning',
          taskList: update.taskList ?? msg.taskList,
          blocks: newBlocks,
          ...(update.taskListUpdate && msg.taskList
            ? {
                taskList: msg.taskList.map((item) =>
                  item.id === update.taskListUpdate!.itemId
                    ? { ...item, status: update.taskListUpdate!.status }
                    : item,
                ),
              }
            : {}),
        }
      })
      return { messages: updated }
    }),

  handleStreamChunk: (chunk) =>
    set((s) => {
      const updated = updateAssistant(s.messages, chunk.taskId, (msg) => {
        if (chunk.isDone) {
          // Stream finished — finalize text block, remove streaming flags
          const finalBlocks = msg.blocks.map((b): ContentBlockUI => {
            if (b.type === 'text' && b.isStreaming) return { ...b, isStreaming: false }
            if (b.type === 'thinking' && b.isStreaming) return { ...b, isStreaming: false }
            return b
          })
          return { ...msg, blocks: finalBlocks, isStreaming: false }
        }

        // Detect thinking blocks (start with 💭 or contain thinking markers)
        const isThinking = chunk.chunk.startsWith('💭')

        const newBlocks = [...msg.blocks]

        if (isThinking) {
          // Find existing streaming thinking block or create new one
          const thinkingIdx = newBlocks.findLastIndex(
            (b) => b.type === 'thinking' && b.isStreaming,
          )
          const cleanChunk = chunk.chunk.replace(/^💭\s*/, '')
          if (thinkingIdx !== -1) {
            newBlocks[thinkingIdx] = {
              ...newBlocks[thinkingIdx],
              content: (newBlocks[thinkingIdx] as { content: string }).content + cleanChunk,
            } as ContentBlockUI
          } else {
            newBlocks.push({ type: 'thinking', content: cleanChunk, isStreaming: true })
          }
        } else {
          // Regular text — find or create streaming text block
          const textIdx = newBlocks.findLastIndex(
            (b) => b.type === 'text' && b.isStreaming,
          )
          if (textIdx !== -1) {
            newBlocks[textIdx] = {
              ...newBlocks[textIdx],
              content: (newBlocks[textIdx] as { content: string }).content + chunk.chunk,
            } as ContentBlockUI
          } else {
            // If first chunk or after a non-text block, start new text block
            if (chunk.isFirst) {
              // Remove any existing streaming text blocks
              const existingTextIdx = newBlocks.findIndex(b => b.type === 'text' && b.isStreaming)
              if (existingTextIdx !== -1) newBlocks.splice(existingTextIdx, 1)
            }
            newBlocks.push({ type: 'text', content: chunk.chunk, isStreaming: true })
          }
        }

        return {
          ...msg,
          blocks: newBlocks,
          plainText: isThinking ? msg.plainText : (msg.plainText + chunk.chunk),
          isStreaming: true,
          activity: isThinking ? 'reasoning' : 'thinking',
        }
      })
      return { messages: updated }
    }),

  handleFollowupQuestion: (question) =>
    set((s) => {
      // Attach to the currently active assistant message
      const activeIdx = s.messages.findLastIndex(
        (m) => m.role === 'assistant' && ((m as AssistantMessage).status === 'executing' || (m as AssistantMessage).status === 'planning'),
      )
      if (activeIdx === -1) return s
      const updated = [...s.messages]
      updated[activeIdx] = {
        ...(updated[activeIdx] as AssistantMessage),
        followupQuestion: question,
      }
      return { messages: updated }
    }),

  clearFollowupQuestion: (questionId) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.role === 'assistant' && (m as AssistantMessage).followupQuestion?.questionId === questionId
          ? { ...m, followupQuestion: undefined }
          : m,
      ),
    })),

  handleApprovalRequest: (request) =>
    set((s) => {
      const activeIdx = s.messages.findLastIndex(
        (m) => m.role === 'assistant' && ((m as AssistantMessage).status === 'executing' || (m as AssistantMessage).status === 'planning'),
      )
      if (activeIdx === -1) return s
      const updated = [...s.messages]
      updated[activeIdx] = {
        ...(updated[activeIdx] as AssistantMessage),
        approvalRequest: request,
      }
      return { messages: updated }
    }),

  clearApprovalRequest: (approvalId) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.role === 'assistant' && (m as AssistantMessage).approvalRequest?.approvalId === approvalId
          ? { ...m, approvalRequest: undefined }
          : m,
      ),
    })),

  handleCheckpoint: (checkpoint) =>
    set((s) => ({
      messages: updateAssistant(s.messages, checkpoint.taskId, (msg) => ({
        ...msg,
        checkpoints: [...(msg.checkpoints ?? []), checkpoint],
      })),
    })),

  handleToolCallInfo: (info) =>
    set((s) => {
      const cardData: ToolCallCardData = {
        taskId: info.taskId,
        agentType: info.agentType,
        step: info.step,
        tool: info.tool,
        toolName: info.toolName,
        args: info.args,
        success: info.success,
        summary: info.summary,
        duration: info.duration,
        resultPreview: info.resultPreview,
        timestamp: info.timestamp ?? Date.now(),
      }

      return {
        messages: updateAssistant(s.messages, info.taskId, (msg) => {
          const activity = inferActivity(info.toolName)
          const newBlocks: ContentBlockUI[] = [...msg.blocks]

          // Close any streaming text block before the tool call
          const streamingTextIdx = newBlocks.findLastIndex(b => b.type === 'text' && b.isStreaming)
          if (streamingTextIdx !== -1) {
            newBlocks[streamingTextIdx] = { ...newBlocks[streamingTextIdx], isStreaming: false } as ContentBlockUI
          }

          // Add tool call block
          newBlocks.push({ type: 'tool_call', data: cardData })

          return { ...msg, blocks: newBlocks, activity }
        }),
      }
    }),

  handleContextUsage: (usage) =>
    set((s) => {
      const usageData: ContextUsageData = {
        taskId: usage.taskId,
        agentType: usage.agentType,
        tokensUsed: usage.tokensUsed,
        budgetTotal: usage.budgetTotal,
        usagePercent: usage.usagePercent,
        messageCount: usage.messageCount,
        condensations: usage.condensations,
        step: usage.step,
      }
      return {
        messages: updateAssistant(s.messages, usage.taskId, (msg) => ({
          ...msg,
          contextUsage: usageData,
        })),
      }
    }),

  handleYouTubePlay: (payload) =>
    set((s) => ({
      messages: updateAssistant(s.messages, payload.taskId, (msg) => {
        const newBlocks: ContentBlockUI[] = [...msg.blocks]
        newBlocks.push({
          type: 'youtube',
          videoId: payload.videoId,
          title: payload.title,
          playlistId: payload.playlistId,
          startAt: payload.startAt,
        })
        return { ...msg, blocks: newBlocks }
      }),
    })),

  // ─── Modes ───
  setModes: (modes) => set({ modes }),
  setSelectedMode: (mode) => set({ selectedMode: mode }),

  // ─── Helpers ───
  getActiveAssistantMessage: () => {
    const { messages } = get()
    const last = messages[messages.length - 1]
    if (last?.role === 'assistant') return last as AssistantMessage
    return undefined
  },

  findAssistantByTaskId: (taskId) => {
    const { messages } = get()
    return messages.find(
      (m) => m.role === 'assistant' && (m as AssistantMessage).taskId === taskId,
    ) as AssistantMessage | undefined
  },
}))
