/**
 * Global IPC Listeners — Always-on event subscriptions.
 *
 * Mounted in AppShell (which NEVER unmounts) so that agent events
 * keep flowing into the Zustand store even when the user navigates
 * away from the Command Center page.
 *
 * Previously these listeners lived inside CommandCenter's useEffect,
 * which meant they were torn down on unmount — losing all streaming
 * data emitted while the user was on another page.
 */

import { useEffect } from 'react'
import { useChatStore } from '../features/command-center/chat-store'

/**
 * Subscribe to all agent IPC channels and forward events to the chat store.
 * Must be called from a component that never unmounts (e.g. AppShell).
 */
export function useGlobalIpcListeners(): void {
  useEffect(() => {
    const unsubs = [
      window.brainwave.onSessionCreated((session) => useChatStore.getState().addSession(session)),
      window.brainwave.onTaskUpdate((update) => useChatStore.getState().handleTaskUpdate(update)),
      window.brainwave.onStreamChunk((chunk) => useChatStore.getState().handleStreamChunk(chunk)),
      window.brainwave.onAskUser((question) => useChatStore.getState().handleFollowupQuestion(question)),
      window.brainwave.onApprovalNeeded((request) => useChatStore.getState().handleApprovalRequest(request)),
      window.brainwave.onCheckpointCreated((checkpoint) => useChatStore.getState().handleCheckpoint(checkpoint)),
      window.brainwave.onToolCallInfo((info) => useChatStore.getState().handleToolCallInfo(info)),
      window.brainwave.onContextUsage((usage) => useChatStore.getState().handleContextUsage(usage)),
      window.brainwave.onYouTubePlay((payload) => useChatStore.getState().handleYouTubePlay(payload)),
    ]

    console.log('[AppShell] Global IPC listeners registered (9 channels)')

    return () => {
      unsubs.forEach((unsub) => unsub())
      console.log('[AppShell] Global IPC listeners torn down')
    }
  }, [])
}
