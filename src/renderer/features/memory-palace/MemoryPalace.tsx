import { Brain, Search, Database, Users } from 'lucide-react'

const MEMORY_TYPES = [
  { label: 'Episodic', count: 0, icon: Brain, description: 'Task experiences and outcomes' },
  { label: 'Semantic', count: 0, icon: Database, description: 'Facts and learned knowledge' },
  { label: 'Procedural', count: 0, icon: Search, description: 'How-to patterns and workflows' },
  { label: 'People', count: 0, icon: Users, description: 'People knowledge graph' },
]

export function MemoryPalace() {
  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Brain className="w-5 h-5 text-agent-memory" />
        <h2 className="text-lg font-semibold text-white">Memory Palace</h2>
      </div>

      {/* Memory type cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {MEMORY_TYPES.map((mem) => {
          const Icon = mem.icon
          return (
            <div key={mem.label} className="glass-card-hover p-4 cursor-pointer">
              <div className="flex items-center gap-3 mb-2">
                <Icon className="w-5 h-5 text-agent-memory" />
                <h3 className="text-sm font-medium text-white">{mem.label}</h3>
              </div>
              <p className="text-xs text-gray-500 mb-3">{mem.description}</p>
              <p className="text-2xl font-bold text-white">{mem.count}</p>
              <p className="text-[11px] text-gray-600">memories stored</p>
            </div>
          )
        })}
      </div>

      {/* Search */}
      <div className="glass-card p-4">
        <div className="flex items-center gap-3 mb-4">
          <Search className="w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search memories..."
            className="flex-1 bg-transparent text-sm text-white placeholder:text-gray-600 focus:outline-none"
          />
        </div>
        <p className="text-sm text-gray-600 text-center py-8">
          Memories will appear here as Brainwave learns from tasks.
        </p>
      </div>
    </div>
  )
}
