import { useState } from 'react'
import { Send, Sparkles, Clock, CheckCircle2 } from 'lucide-react'

// Mock recent tasks for the placeholder
const RECENT_TASKS = [
  { id: '1', prompt: 'No tasks yet — submit your first task below', status: 'info' as const },
]

export function CommandCenter() {
  const [input, setInput] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return

    // TODO: Wire to brainwave.submitTask()
    console.log('[CommandCenter] Submit:', input)
    setInput('')
  }

  return (
    <div className="flex flex-col h-full max-w-4xl mx-auto">
      {/* Hero / Welcome */}
      <div className="text-center py-12">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent/10 mb-4 glow-accent">
          <Sparkles className="w-8 h-8 text-accent" />
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">What should I work on?</h2>
        <p className="text-gray-500 text-sm max-w-md mx-auto">
          Describe a task and I'll plan, delegate to specialized agents, and execute it autonomously.
        </p>
      </div>

      {/* Task Input */}
      <form onSubmit={handleSubmit} className="glass-card p-4 mb-8">
        <div className="flex gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g., Build a REST API for user authentication..."
            className="flex-1 bg-white/[0.03] border border-white/[0.08] rounded-lg px-4 py-3 text-sm text-white
                       placeholder:text-gray-600 focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20
                       transition-all"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="flex items-center gap-2 px-5 py-3 rounded-lg bg-accent text-white text-sm font-medium
                       hover:bg-accent/90 disabled:opacity-30 disabled:cursor-not-allowed
                       transition-all active:scale-[0.98]"
          >
            <Send className="w-4 h-4" />
            Submit
          </button>
        </div>
      </form>

      {/* Recent Activity */}
      <div>
        <h3 className="text-sm font-semibold text-gray-400 mb-3 flex items-center gap-2">
          <Clock className="w-4 h-4" />
          Recent Activity
        </h3>
        <div className="space-y-2">
          {RECENT_TASKS.map((task) => (
            <div
              key={task.id}
              className="glass-card-hover p-4 flex items-center gap-3"
            >
              <CheckCircle2 className="w-4 h-4 text-gray-600 flex-shrink-0" />
              <span className="text-sm text-gray-400">{task.prompt}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
