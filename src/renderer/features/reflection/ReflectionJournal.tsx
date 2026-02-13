import { BookOpen, TrendingUp, AlertTriangle, Lightbulb } from 'lucide-react'

export function ReflectionJournal() {
  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <BookOpen className="w-5 h-5 text-agent-reflection" />
        <h2 className="text-lg font-semibold text-white">Reflection Journal</h2>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="glass-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4 text-status-success" />
            <span className="text-xs text-gray-400">Patterns Learned</span>
          </div>
          <p className="text-2xl font-bold text-white">0</p>
        </div>
        <div className="glass-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-status-warning" />
            <span className="text-xs text-gray-400">Mistakes Logged</span>
          </div>
          <p className="text-2xl font-bold text-white">0</p>
        </div>
        <div className="glass-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Lightbulb className="w-4 h-4 text-accent" />
            <span className="text-xs text-gray-400">Insights Generated</span>
          </div>
          <p className="text-2xl font-bold text-white">0</p>
        </div>
      </div>

      {/* Journal entries */}
      <div className="glass-card p-4">
        <p className="text-sm text-gray-600 text-center py-12">
          The Reflection Agent will log learnings, mistakes, and insights here after completing tasks.
        </p>
      </div>
    </div>
  )
}
