/**
 * CommandCenter — Refactored. Composes modular chat UI components.
 *
 * Session sidebar + ChatMessageList + ChatInput + IPC wiring.
 * The 1,500-line monolith is now ~300 lines of composition.
 */

import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Plus,
  MessageSquare,
  Trash2,
  Pencil,
  PanelLeftClose,
  PanelLeft,
  Bot,
  Sparkles,
} from 'lucide-react'
import type {
  ChatSession,
  ImageAttachment,
  DocumentAttachment,
} from '@shared/types'
import { useChatStore } from './chat-store'
import { ChatMessageList } from './ChatMessageList'
import { ChatInput } from './ChatInput'
import type { AssistantMessage, UserMessage } from './chat-types'

export function CommandCenter() {
  const [searchParams, setSearchParams] = useSearchParams()
  const store = useChatStore()

  // Sidebar editing state (local — only relevant to sidebar UI)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  // ─── Boot: Load sessions + modes ───

  useEffect(() => {
    Promise.all([
      window.brainwave.listSessions('user'),
      window.brainwave.listSessions('autonomous'),
    ]).then(([userList, autoList]) => {
      store.setSessions(userList)
      store.setAutoSessions(autoList)

      const deepLinkSession = searchParams.get('session')
      if (deepLinkSession) {
        const inUser = userList.some((s) => s.id === deepLinkSession)
        const inAuto = autoList.some((s) => s.id === deepLinkSession)
        if (inUser) { store.setSidebarTab('user'); store.setActiveSessionId(deepLinkSession) }
        else if (inAuto) { store.setSidebarTab('autonomous'); store.setActiveSessionId(deepLinkSession) }
        setSearchParams({}, { replace: true })
      } else if (userList.length > 0) {
        store.setActiveSessionId(userList[0].id)
      }
    }).catch(console.error)

    window.brainwave.getModes().then(store.setModes).catch(console.error)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── IPC Subscriptions (single useEffect, clean teardown) ───

  useEffect(() => {
    const unsubs = [
      window.brainwave.onSessionCreated((session) => store.addSession(session)),
      window.brainwave.onTaskUpdate((update) => store.handleTaskUpdate(update)),
      window.brainwave.onStreamChunk((chunk) => store.handleStreamChunk(chunk)),
      window.brainwave.onAskUser((question) => store.handleFollowupQuestion(question)),
      window.brainwave.onApprovalNeeded((request) => store.handleApprovalRequest(request)),
      window.brainwave.onCheckpointCreated((checkpoint) => store.handleCheckpoint(checkpoint)),
      window.brainwave.onToolCallInfo((info) => store.handleToolCallInfo(info)),
      window.brainwave.onContextUsage((usage) => store.handleContextUsage(usage)),
    ]
    return () => unsubs.forEach((unsub) => unsub())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Load messages when active session changes ───

  useEffect(() => {
    const sessionId = store.activeSessionId
    if (!sessionId) {
      store.setMessages([])
      store.setLoaded(true)
      return
    }
    store.setLoaded(false)
    window.brainwave.getSessionTasks(sessionId, 50).then(async (history) => {
      // Convert historical tasks to ChatMessage[]
      const messages = history.reverse().flatMap((h): (UserMessage | AssistantMessage)[] => {
        const userMsg: UserMessage = {
          id: `user-${h.id}`,
          role: 'user',
          content: h.prompt,
          timestamp: h.createdAt,
        }
        const assistantMsg: AssistantMessage = {
          id: `assistant-${h.id}`,
          role: 'assistant',
          taskId: h.id,
          blocks: h.result
            ? [{ type: 'text', content: typeof h.result === 'string' ? h.result : JSON.stringify(h.result, null, 2), isStreaming: false }]
            : [],
          activity: h.status === 'completed' ? 'completed' : h.status === 'failed' ? 'error' : 'idle',
          plainText: typeof h.result === 'string' ? h.result : (h.result ? JSON.stringify(h.result) : ''),
          isStreaming: h.status === 'executing' || h.status === 'planning',
          status: h.status,
          error: h.error,
          result: h.result,
          timestamp: h.createdAt,
        }
        return [userMsg, assistantMsg]
      })

      // Replay live state for active tasks
      const activeIds = messages
        .filter((m): m is AssistantMessage => m.role === 'assistant' && (m.status === 'queued' || m.status === 'planning' || m.status === 'executing'))
        .map((m) => m.taskId)

      if (activeIds.length > 0) {
        try {
          const liveStates = await window.brainwave.getTaskLiveState(activeIds)
          for (const msg of messages) {
            if (msg.role !== 'assistant') continue
            const aMsg = msg as AssistantMessage
            const live = liveStates[aMsg.taskId]
            if (live) {
              aMsg.activity = live.currentStep ? 'thinking' : 'idle'
              if (live.status) aMsg.status = live.status
            }
          }
        } catch (err) {
          console.warn('[CommandCenter] Failed to fetch task live state:', err)
        }
      }

      store.setMessages(messages)
      store.setLoaded(true)
    }).catch(() => {
      store.setLoaded(true)
    })
  }, [store.activeSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Actions ───

  const handleNewChat = useCallback(async () => {
    try {
      const session = await window.brainwave.createSession('New Chat')
      store.addSession(session)
      store.setActiveSessionId(session.id)
      store.setSidebarTab('user')
      store.setMessages([])
    } catch (err) {
      console.error('[CommandCenter] Failed to create session:', err)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = useCallback(async (
    prompt: string,
    images?: ImageAttachment[],
    documents?: DocumentAttachment[],
    mode?: string,
  ) => {
    let sessionId = store.activeSessionId
    const msgs = store.messages

    // Auto-create session if none active
    if (!sessionId) {
      const session = await window.brainwave.createSession(prompt.slice(0, 60) || 'Image chat')
      store.addSession(session)
      store.setActiveSessionId(session.id)
      sessionId = session.id
    } else if (msgs.length === 0) {
      // Auto-title for first message
      const title = (prompt || 'Image chat').slice(0, 60)
      const updated = await window.brainwave.renameSession(sessionId, title)
      if (updated) store.updateSessionTitle(sessionId, updated.title)
    }

    // Add user message to store
    const userMsgId = crypto.randomUUID()
    store.addUserMessage({
      id: userMsgId,
      role: 'user',
      content: prompt || 'Analyze the attached file(s)',
      images,
      documents: documents?.map((d) => ({ name: d.name, extension: d.extension })),
      timestamp: Date.now(),
    })

    // Submit task
    const { taskId } = await window.brainwave.submitTask({
      id: crypto.randomUUID(),
      prompt: prompt || 'Analyze the attached file(s)',
      priority: 'normal',
      sessionId: sessionId!,
      images,
      documents,
      mode,
    })

    // Add assistant message placeholder
    store.addAssistantMessage({
      id: `assistant-${taskId}`,
      role: 'assistant',
      taskId,
      blocks: [],
      activity: 'idle',
      plainText: '',
      isStreaming: true,
      status: 'queued',
      timestamp: Date.now(),
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleFollowupRespond = useCallback(async (questionId: string, answer: string) => {
    try {
      await window.brainwave.respondToAgent(questionId, answer)
      store.clearFollowupQuestion(questionId)
    } catch (err) {
      console.error('[CommandCenter] Failed to respond to agent:', err)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleApprove = useCallback(async (approvalId: string) => {
    try {
      await window.brainwave.respondToApproval(approvalId, true)
      store.clearApprovalRequest(approvalId)
    } catch (err) {
      console.error('[CommandCenter] Failed to approve:', err)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleReject = useCallback(async (approvalId: string) => {
    try {
      await window.brainwave.respondToApproval(approvalId, false)
      store.clearApprovalRequest(approvalId)
    } catch (err) {
      console.error('[CommandCenter] Failed to reject:', err)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await window.brainwave.deleteSession(id)
      store.removeSession(id)
    } catch (err) {
      console.error('[CommandCenter] Failed to delete session:', err)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleRenameSession = useCallback(async (id: string, title: string) => {
    if (!title.trim()) { setEditingSessionId(null); return }
    try {
      const updated = await window.brainwave.renameSession(id, title.trim())
      if (updated) store.updateSessionTitle(id, updated.title)
    } catch (err) {
      console.error('[CommandCenter] Failed to rename session:', err)
    }
    setEditingSessionId(null)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Derived ───

  const activeSession = store.sessions.find((s) => s.id === store.activeSessionId)
    || store.autoSessions.find((s) => s.id === store.activeSessionId)
  const visibleSessions = store.sidebarTab === 'user' ? store.sessions : store.autoSessions

  // ─── Render ───

  return (
    <div className="flex h-full">
      {/* ─── Session Sidebar ─── */}
      {store.sidebarOpen && (
        <div
          style={{ minWidth: '325px' }}
          className="w-64 flex-shrink-0 border-r border-white/[0.06] flex flex-col bg-white/[0.01]"
        >
          {/* Header with Tabs */}
          <div className="border-b border-white/[0.06]">
            <div className="p-3 flex items-center justify-between">
              <div className="flex items-center gap-0.5 bg-white/[0.04] rounded-lg p-0.5">
                <button
                  onClick={() => store.setSidebarTab('user')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1.5
                    ${store.sidebarTab === 'user'
                      ? 'bg-white/[0.1] text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-300'
                    }`}
                >
                  <MessageSquare className="w-3 h-3" />
                  Chats
                  {store.sessions.length > 0 && (
                    <span className="text-[10px] opacity-60">{store.sessions.length}</span>
                  )}
                </button>
                <button
                  onClick={() => store.setSidebarTab('autonomous')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1.5
                    ${store.sidebarTab === 'autonomous'
                      ? 'bg-white/[0.1] text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-300'
                    }`}
                >
                  <Bot className="w-3 h-3" />
                  Auto
                  {store.autoSessions.length > 0 && (
                    <span className="text-[10px] opacity-60">{store.autoSessions.length}</span>
                  )}
                </button>
              </div>
              <div className="flex items-center gap-1">
                {store.sidebarTab === 'user' && (
                  <button
                    onClick={handleNewChat}
                    className="p-1.5 rounded-md hover:bg-white/[0.06] text-gray-400 hover:text-white transition-colors"
                    title="New Chat"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={() => store.setSidebarOpen(false)}
                  className="p-1.5 rounded-md hover:bg-white/[0.06] text-gray-400 hover:text-white transition-colors"
                  title="Close sidebar"
                >
                  <PanelLeftClose className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Session List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {visibleSessions.length === 0 ? (
              <p className="text-[11px] text-gray-600 text-center py-6">
                {store.sidebarTab === 'user' ? 'No chats yet' : 'No autonomous sessions yet'}
              </p>
            ) : (
              visibleSessions.map((session) => (
                <div
                  key={session.id}
                  className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors
                    ${store.activeSessionId === session.id
                      ? 'bg-accent/10 text-white'
                      : 'text-gray-400 hover:bg-white/[0.04] hover:text-gray-200'
                    }`}
                  onClick={() => { store.setActiveSessionId(session.id); setEditingSessionId(null) }}
                >
                  {store.sidebarTab === 'autonomous'
                    ? <Bot className="w-3.5 h-3.5 flex-shrink-0 opacity-60 text-purple-400" />
                    : <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
                  }
                  {editingSessionId === session.id ? (
                    <input
                      autoFocus
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onBlur={() => handleRenameSession(session.id, editTitle)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameSession(session.id, editTitle)
                        if (e.key === 'Escape') setEditingSessionId(null)
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 bg-transparent text-xs text-white border-b border-accent/40 outline-none py-0.5 min-w-0"
                    />
                  ) : (
                    <span className="flex-1 text-xs truncate">{session.title}</span>
                  )}

                  <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingSessionId(session.id)
                        setEditTitle(session.title)
                      }}
                      className="p-1 rounded hover:bg-white/[0.08] text-gray-500 hover:text-gray-300"
                      title="Rename"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteSession(session.id)
                      }}
                      className="p-1 rounded hover:bg-white/[0.08] text-gray-500 hover:text-red-400"
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ─── Main Chat Area ─── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-white/[0.06] flex-shrink-0">
          {!store.sidebarOpen && (
            <button
              onClick={() => store.setSidebarOpen(true)}
              className="p-1.5 rounded-md hover:bg-white/[0.06] text-gray-400 hover:text-white transition-colors"
              title="Open sidebar"
            >
              <PanelLeft className="w-4 h-4" />
            </button>
          )}
          {activeSession ? (
            <h3 className="text-sm font-medium text-white truncate">{activeSession.title}</h3>
          ) : (
            <h3 className="text-sm text-gray-500">Select or start a new chat</h3>
          )}
        </div>

        <div className="flex flex-col flex-1 max-w-4xl mx-auto w-full min-h-0">
          {/* No session — welcome state */}
          {!store.activeSessionId && (
            <div className="min-h-full flex-1 p-4 flex items-center justify-center">
              <div className="text-center mt-4 p-4">
                <div className="inline-flex mt-4 p-4 items-center justify-center w-16 h-16 rounded-2xl bg-accent/10 mb-4 glow-accent">
                  <Sparkles className="w-8 h-8 text-accent" />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">What should I work on?</h2>
                <p className="text-gray-500 text-sm max-w-md mx-auto mb-6">
                  Describe a task and I'll plan, delegate to specialized agents, and execute it autonomously.
                </p>
                <button
                  onClick={handleNewChat}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium
                             hover:bg-accent/90 transition-all active:scale-[0.98]"
                >
                  <Plus className="w-4 h-4" /> New Chat
                </button>
              </div>
            </div>
          )}

          {/* Active session — message list + input */}
          {store.activeSessionId && (
            <>
              <ChatMessageList
                messages={store.messages}
                loaded={store.loaded}
                onFollowupRespond={handleFollowupRespond}
                onApprove={handleApprove}
                onReject={handleReject}
              />

              <ChatInput
                onSubmit={handleSubmit}
                modes={store.modes}
                selectedMode={store.selectedMode}
                onModeChange={store.setSelectedMode}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
