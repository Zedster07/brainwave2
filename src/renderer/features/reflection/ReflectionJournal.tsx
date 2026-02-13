import { useState, useEffect, useCallback } from 'react'
import { BookOpen, TrendingUp, AlertTriangle, Lightbulb, RefreshCw, Tag } from 'lucide-react'
import type { MemoryEntry } from '@shared/types'

type LessonCategory = 'success' | 'failure' | 'insight'

function categorizeEntry(entry: MemoryEntry): LessonCategory {
  const tags = entry.tags.map((t) => t.toLowerCase())
  const content = entry.content.toLowerCase()
  if (tags.includes('failure-pattern') || tags.includes('error') || content.includes('mistake') || content.includes('failed')) {
    return 'failure'
  }
  if (tags.includes('success-pattern') || tags.includes('optimization') || content.includes('worked well')) {
    return 'success'
  }
  return 'insight'
}

const CATEGORY_STYLE: Record<LessonCategory, { label: string; color: string; bg: string }> = {
  success: { label: 'Pattern', color: 'text-green-400', bg: 'bg-green-500/10' },
  failure: { label: 'Mistake', color: 'text-red-400', bg: 'bg-red-500/10' },
  insight: { label: 'Insight', color: 'text-accent', bg: 'bg-accent/10' },
}

export function ReflectionJournal() {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(true)

  const loadReflections = useCallback(async () => {
    setLoading(true)
    try {
      // Query semantic memories — reflections are stored there by the ReflectionAgent
      const results = await window.brainwave.queryMemory({
        query: 'reflection lesson pattern insight learning',
        type: 'semantic',
        limit: 100,
      })
      setEntries(results)
    } catch (err) {
      console.error('Failed to load reflections:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadReflections()
  }, [loadReflections])

  const successCount = entries.filter((e) => categorizeEntry(e) === 'success').length
  const failureCount = entries.filter((e) => categorizeEntry(e) === 'failure').length
  const insightCount = entries.filter((e) => categorizeEntry(e) === 'insight').length

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 mb-6">
        <BookOpen className="w-5 h-5 text-agent-reflection" />
        <h2 className="text-lg font-semibold text-white">Reflection Journal</h2>
        <span className="text-xs text-gray-500 bg-white/[0.04] px-2 py-0.5 rounded-full">
          {entries.length} entries
        </span>
        <button
          onClick={loadReflections}
          className="ml-auto p-1.5 rounded-md hover:bg-white/[0.04] text-gray-500 hover:text-gray-300 transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="glass-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4 text-status-success" />
            <span className="text-xs text-gray-400">Patterns Learned</span>
          </div>
          <p className="text-2xl font-bold text-white">{successCount}</p>
        </div>
        <div className="glass-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-status-warning" />
            <span className="text-xs text-gray-400">Mistakes Logged</span>
          </div>
          <p className="text-2xl font-bold text-white">{failureCount}</p>
        </div>
        <div className="glass-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Lightbulb className="w-4 h-4 text-accent" />
            <span className="text-xs text-gray-400">Insights Generated</span>
          </div>
          <p className="text-2xl font-bold text-white">{insightCount}</p>
        </div>
      </div>

      {/* Journal entries */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
        {loading && entries.length === 0 ? (
          <div className="glass-card p-4">
            <p className="text-sm text-gray-600 text-center py-12 animate-pulse">Loading reflections...</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="glass-card p-4">
            <p className="text-sm text-gray-600 text-center py-12">
              The Reflection Agent will log learnings, mistakes, and insights here after completing tasks.
            </p>
          </div>
        ) : (
          entries.map((entry) => <JournalEntry key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  )
}

// ─── Journal Entry ───

function JournalEntry({ entry }: { entry: MemoryEntry }) {
  const category = categorizeEntry(entry)
  const style = CATEGORY_STYLE[category]

  return (
    <div className="glass-card-hover p-4">
      <div className="flex items-start gap-3">
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${style.bg} ${style.color} flex-shrink-0 mt-0.5`}>
          {style.label}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-300 leading-relaxed">{entry.content}</p>
          <div className="flex items-center gap-3 mt-3">
            <span className="text-[10px] text-gray-600">
              {new Date(entry.createdAt).toLocaleDateString()} {new Date(entry.createdAt).toLocaleTimeString()}
            </span>
            {entry.importance > 0 && (
              <span className="text-[10px] text-gray-600">
                Importance: {Math.round(entry.importance * 100)}%
              </span>
            )}
            {entry.tags.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                <Tag className="w-2.5 h-2.5 text-gray-600" />
                {entry.tags.slice(0, 4).map((tag) => (
                  <span key={tag} className="text-[9px] text-gray-600 bg-white/[0.04] px-1.5 py-0.5 rounded">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
