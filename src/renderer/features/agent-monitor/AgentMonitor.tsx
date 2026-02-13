import { Network, Circle } from 'lucide-react'

const AGENT_TYPES = [
  { id: 'orchestrator', name: 'Orchestrator', color: 'bg-agent-orchestrator', state: 'idle' },
  { id: 'planner', name: 'Planner', color: 'bg-agent-planner', state: 'idle' },
  { id: 'researcher', name: 'Researcher', color: 'bg-agent-researcher', state: 'idle' },
  { id: 'coder', name: 'Coder', color: 'bg-agent-coder', state: 'idle' },
  { id: 'reviewer', name: 'Reviewer', color: 'bg-agent-reviewer', state: 'idle' },
  { id: 'memory', name: 'Memory Agent', color: 'bg-agent-memory', state: 'idle' },
  { id: 'reflection', name: 'Reflection', color: 'bg-agent-reflection', state: 'idle' },
  { id: 'scheduler', name: 'Scheduler', color: 'bg-agent-scheduler', state: 'idle' },
] as const

export function AgentMonitor() {
  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Network className="w-5 h-5 text-accent" />
        <h2 className="text-lg font-semibold text-white">Agent Swarm</h2>
        <span className="text-xs text-gray-500 bg-white/[0.04] px-2 py-0.5 rounded-full">
          {AGENT_TYPES.length} agents
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {AGENT_TYPES.map((agent) => (
          <div key={agent.id} className="glass-card-hover p-4">
            <div className="flex items-center gap-3 mb-3">
              <div className={`w-3 h-3 rounded-full ${agent.color} opacity-60`} />
              <h3 className="text-sm font-medium text-white">{agent.name}</h3>
            </div>

            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Circle className="w-3 h-3 text-gray-600" />
              <span className="capitalize">{agent.state}</span>
            </div>

            <div className="mt-3 pt-3 border-t border-white/[0.04]">
              <p className="text-[11px] text-gray-600">No active task</p>
            </div>
          </div>
        ))}
      </div>

      {/* Activity Log */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold text-gray-400 mb-3">Activity Log</h3>
        <div className="glass-card p-4">
          <p className="text-sm text-gray-600 text-center py-8">
            Agent activity will appear here when tasks are running.
          </p>
        </div>
      </div>
    </div>
  )
}
