import { useState, useEffect, useCallback, useRef } from 'react'
import { Network, Circle, Activity, Loader2, CheckCircle2, AlertTriangle, Clock } from 'lucide-react'
import type { AgentStatus, AgentLogEntry } from '@shared/types'

const AGENT_COLORS: Record<string, string> = {
  orchestrator: 'bg-agent-orchestrator',
  planner: 'bg-agent-planner',
  researcher: 'bg-agent-researcher',
  coder: 'bg-agent-coder',
  writer: 'bg-agent-writer',
  analyst: 'bg-agent-analyst',
  critic: 'bg-agent-critic',
  reviewer: 'bg-agent-reviewer',
  reflection: 'bg-agent-reflection',
  executor: 'bg-agent-executor',
}

const MAX_LOGS = 200

export function AgentMonitor() {
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [logs, setLogs] = useState<AgentLogEntry[]>([])
  const logEndRef = useRef<HTMLDivElement>(null)
  // Track which agents have real-time state overrides (from log events)
  const realtimeState = useRef(new Map<string, { state: string; taskId?: string; updatedAt: number }>())

  // Load agent status — only once to discover agent list, not for state
  const loadAgents = useCallback(async () => {
    try {
      const status = await window.brainwave.getAgentStatus()
      // Merge: use polled data for agent list but preserve real-time state
      setAgents(status.map((a) => {
        const rt = realtimeState.current.get(a.type)
        if (rt && Date.now() - rt.updatedAt < 30000) {
          // Real-time state is recent, use it
          return { ...a, state: rt.state as AgentStatus['state'], currentTaskId: rt.taskId }
        }
        return a
      }))
    } catch (err) {
      console.error('Failed to load agent status:', err)
    }
  }, [])

  // Load persisted log history on mount
  useEffect(() => {
    window.brainwave.getLogHistory(100).then((history) => {
      setLogs(history)
    }).catch((err) => console.error('Failed to load log history:', err))
  }, [])

  useEffect(() => {
    loadAgents()
    // Poll agent list every 5s (for discovery, not state)
    const interval = setInterval(loadAgents, 5000)
    return () => clearInterval(interval)
  }, [loadAgents])

  // Subscribe to agent log events — these drive real-time state
  useEffect(() => {
    const unsubscribe = window.brainwave.onAgentLog((log: AgentLogEntry) => {
      setLogs((prev) => {
        const next = [log, ...prev]
        return next.length > MAX_LOGS ? next.slice(0, MAX_LOGS) : next
      })

      // Update agent state based on log and track in ref
      const isThinking = log.message.includes('Thinking')
      const isCompleted = log.message.includes('Completed')
      const isError = log.level === 'error'
      const newState = isThinking ? 'thinking' : (isCompleted || isError) ? 'idle' : null

      if (newState) {
        realtimeState.current.set(log.agentType, {
          state: newState,
          taskId: isThinking ? log.taskId : undefined,
          updatedAt: Date.now(),
        })

        setAgents((prev) =>
          prev.map((a) => {
            if (a.type === log.agentType) {
              return {
                ...a,
                state: newState as AgentStatus['state'],
                currentTaskId: isThinking ? log.taskId : a.currentTaskId,
              }
            }
            return a
          })
        )
      }
    })
    return unsubscribe
  }, [])

  // Also listen to task updates for status changes
  useEffect(() => {
    const unsubscribe = window.brainwave.onTaskUpdate((update) => {
      // When a task completes/fails, reset agents to idle
      if (update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled') {
        setAgents((prev) =>
          prev.map((a) =>
            a.currentTaskId === update.taskId ? { ...a, state: 'idle', currentTaskId: undefined } : a
          )
        )
      }
    })
    return unsubscribe
  }, [])

  const activeCount = agents.filter((a) => a.state !== 'idle').length

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 mb-6">
        <Network className="w-5 h-5 text-accent" />
        <h2 className="text-lg font-semibold text-white">Agent Swarm</h2>
        <span className="text-xs text-gray-500 bg-white/[0.04] px-2 py-0.5 rounded-full">
          {agents.length} agents
        </span>
        {activeCount > 0 && (
          <span className="text-xs text-accent bg-accent/10 px-2 py-0.5 rounded-full animate-pulse">
            {activeCount} active
          </span>
        )}
      </div>

      {/* Agent Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
        {agents.length === 0 && (
          // Show skeleton agent cards if status hasn't loaded yet
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="glass-card p-4 animate-pulse">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-3 h-3 rounded-full bg-gray-700" />
                <div className="h-4 bg-gray-700 rounded w-20" />
              </div>
              <div className="h-3 bg-gray-800 rounded w-12" />
            </div>
          ))
        )}
      </div>

      {/* Activity Log */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-400 flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Activity Log
            {logs.length > 0 && (
              <span className="text-[10px] bg-white/[0.04] px-1.5 py-0.5 rounded-full">{logs.length}</span>
            )}
          </h3>
          {logs.length > 0 && (
            <button
              onClick={() => setLogs([])}
              className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
        <div className="glass-card p-4 flex-1 overflow-y-auto min-h-[120px]">
          {logs.length === 0 ? (
            <p className="text-sm text-gray-600 text-center py-8">
              Agent activity will appear here when tasks are running.
            </p>
          ) : (
            <div className="space-y-1">
              {logs.map((log) => (
                <LogEntry key={log.id} log={log} />
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Agent Card ───

function AgentCard({ agent }: { agent: AgentStatus }) {
  const color = AGENT_COLORS[agent.type] || 'bg-gray-500'
  const stateColor =
    agent.state === 'thinking' ? 'text-accent' :
    agent.state === 'acting' ? 'text-amber-400' :
    agent.state === 'waiting' ? 'text-blue-400' :
    'text-gray-600'

  return (
    <div className={`glass-card-hover p-4 ${agent.state !== 'idle' ? 'border border-accent/20' : ''}`}>
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-3 h-3 rounded-full ${color} ${agent.state !== 'idle' ? 'animate-pulse' : 'opacity-60'}`} />
        <h3 className="text-sm font-medium text-white capitalize">{agent.type}</h3>
      </div>

      <div className="flex items-center gap-2 text-xs">
        {agent.state === 'idle' ? (
          <>
            <Circle className="w-3 h-3 text-gray-600" />
            <span className="text-gray-600">Idle</span>
          </>
        ) : agent.state === 'thinking' ? (
          <>
            <Loader2 className="w-3 h-3 text-accent animate-spin" />
            <span className={stateColor}>Thinking...</span>
          </>
        ) : (
          <>
            <Activity className="w-3 h-3" />
            <span className={`capitalize ${stateColor}`}>{agent.state}</span>
          </>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-white/[0.04]">
        {agent.model ? (
          <p className="text-[10px] text-gray-600 truncate" title={agent.model}>{agent.model}</p>
        ) : (
          <p className="text-[10px] text-gray-700">No model assigned</p>
        )}
      </div>
    </div>
  )
}

// ─── Log Entry ───

function LogEntry({ log }: { log: AgentLogEntry }) {
  const levelColor =
    log.level === 'error' ? 'text-red-400' :
    log.level === 'warn' ? 'text-yellow-400' :
    'text-gray-500'

  const LevelIcon =
    log.level === 'error' ? AlertTriangle :
    log.level === 'warn' ? AlertTriangle :
    log.level === 'info' ? CheckCircle2 :
    Clock

  return (
    <div className="flex items-start gap-2 py-1">
      <LevelIcon className={`w-3 h-3 mt-0.5 flex-shrink-0 ${levelColor}`} />
      <span className="text-[10px] text-gray-600 w-16 flex-shrink-0 capitalize">{log.agentType}</span>
      <span className={`text-[11px] flex-1 ${log.level === 'error' ? 'text-red-400/80' : 'text-gray-400'}`}>
        {log.message}
      </span>
      <span className="text-[9px] text-gray-700 flex-shrink-0">
        {new Date(log.timestamp).toLocaleTimeString()}
      </span>
    </div>
  )
}
