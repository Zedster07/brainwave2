import { LayoutDashboard, GitBranch } from 'lucide-react'

export function PlanBoard() {
  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <LayoutDashboard className="w-5 h-5 text-agent-planner" />
        <h2 className="text-lg font-semibold text-white">Plan Board</h2>
      </div>

      {/* Columns: Queued | Planning | In Progress | Done */}
      <div className="grid grid-cols-4 gap-4">
        {['Queued', 'Planning', 'Executing', 'Completed'].map((col) => (
          <div key={col}>
            <div className="flex items-center gap-2 mb-3">
              <GitBranch className="w-3.5 h-3.5 text-gray-500" />
              <h3 className="text-sm font-medium text-gray-400">{col}</h3>
              <span className="text-[10px] text-gray-600 bg-white/[0.04] px-1.5 py-0.5 rounded">0</span>
            </div>
            <div className="glass-card p-3 min-h-[200px] flex items-center justify-center">
              <p className="text-xs text-gray-600">No tasks</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
