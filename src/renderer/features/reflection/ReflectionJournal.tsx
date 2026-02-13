import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  BookOpen, TrendingUp, AlertTriangle, Lightbulb, RefreshCw,
  Tag, Search, ChevronDown, ChevronUp, ArrowUpDown, Calendar,
  Star, Filter
} from 'lucide-react'
import type { MemoryEntry } from '@shared/types'

// ─── Category Classification ───────────────────────────

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

const CATEGORY_STYLE: Record<LessonCategory, { label: string; color: string; bg: string; Icon: typeof TrendingUp }> = {
  success: { label: 'Pattern', color: 'text-green-400', bg: 'bg-green-500/10', Icon: TrendingUp },
  failure: { label: 'Mistake', color: 'text-red-400', bg: 'bg-red-500/10', Icon: AlertTriangle },
  insight: { label: 'Insight', color: 'text-accent', bg: 'bg-accent/10', Icon: Lightbulb },
}

type SortKey = 'date' | 'importance'

// ─── Reflection Journal ────────────────────────────────

export function ReflectionJournal() {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<LessonCategory | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDesc, setSortDesc] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const loadReflections = useCallback(async () => {
    setLoading(true)
    try {
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

  // Category counts (unfiltered)
  const counts = useMemo(() => {
    const c = { success: 0, failure: 0, insight: 0 }
    entries.forEach((e) => c[categorizeEntry(e)]++)
    return c
  }, [entries])

  // Filter + sort pipeline
  const filteredEntries = useMemo(() => {
    let result = entries

    // Category filter
    if (categoryFilter) {
      result = result.filter((e) => categorizeEntry(e) === categoryFilter)
    }

    // Text search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (e) =>
          e.content.toLowerCase().includes(q) ||
          e.tags.some((t) => t.toLowerCase().includes(q))
      )
    }

    // Sort
    result = [...result].sort((a, b) => {
      if (sortKey === 'importance') {
        return sortDesc ? b.importance - a.importance : a.importance - b.importance
      }
      const da = new Date(a.createdAt).getTime()
      const db = new Date(b.createdAt).getTime()
      return sortDesc ? db - da : da - db
    })

    return result
  }, [entries, categoryFilter, searchQuery, sortKey, sortDesc])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc(!sortDesc)
    } else {
      setSortKey(key)
      setSortDesc(true)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <BookOpen className="w-5 h-5 text-agent-reflection" />
        <h2 className="text-lg font-semibold text-white">Reflection Journal</h2>
        <span className="text-xs text-gray-500 bg-white/[0.04] px-2 py-0.5 rounded-full">
          {entries.length} entries
        </span>
        <div className="flex-1" />
        <button
          onClick={loadReflections}
          className="p-1.5 rounded-md hover:bg-white/[0.04] text-gray-500 hover:text-gray-300 transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Stats row — clickable as category filters */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        {(['success', 'failure', 'insight'] as LessonCategory[]).map((cat) => {
          const style = CATEGORY_STYLE[cat]
          const CatIcon = style.Icon
          const isActive = categoryFilter === cat

          return (
            <button
              key={cat}
              onClick={() => setCategoryFilter(isActive ? null : cat)}
              className={`glass-card p-4 text-left transition-all duration-200 ${
                isActive ? 'ring-1 ring-accent/30 bg-white/[0.04]' : 'hover:bg-white/[0.02]'
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <CatIcon className={`w-4 h-4 ${style.color}`} />
                <span className="text-xs text-gray-400">
                  {cat === 'success' ? 'Patterns Learned' : cat === 'failure' ? 'Mistakes Logged' : 'Insights Generated'}
                </span>
              </div>
              <p className="text-2xl font-bold text-white">{counts[cat]}</p>
            </button>
          )
        })}
      </div>

      {/* Toolbar: search + sort */}
      <div className="flex items-center gap-3 mb-4">
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            placeholder="Search reflections..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white/[0.04] border border-white/[0.06] rounded-md pl-8 pr-3 py-1.5 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-accent/40 transition-colors"
          />
        </div>

        {/* Active filter indicator */}
        {categoryFilter && (
          <span className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded-full ${CATEGORY_STYLE[categoryFilter].bg} ${CATEGORY_STYLE[categoryFilter].color}`}>
            <Filter className="w-2.5 h-2.5" />
            {CATEGORY_STYLE[categoryFilter].label}
            <button onClick={() => setCategoryFilter(null)} className="ml-1 hover:opacity-70">&times;</button>
          </span>
        )}

        <div className="flex-1" />

        {/* Sort controls */}
        <div className="flex items-center gap-1">
          <ArrowUpDown className="w-3 h-3 text-gray-600" />
          <button
            onClick={() => toggleSort('date')}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors ${
              sortKey === 'date' ? 'bg-white/[0.06] text-gray-300' : 'text-gray-500 hover:text-gray-400'
            }`}
          >
            <Calendar className="w-3 h-3" />
            Date {sortKey === 'date' && (sortDesc ? '↓' : '↑')}
          </button>
          <button
            onClick={() => toggleSort('importance')}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors ${
              sortKey === 'importance' ? 'bg-white/[0.06] text-gray-300' : 'text-gray-500 hover:text-gray-400'
            }`}
          >
            <Star className="w-3 h-3" />
            Importance {sortKey === 'importance' && (sortDesc ? '↓' : '↑')}
          </button>
        </div>
      </div>

      {/* Journal entries */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
        {loading && entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <BookOpen className="w-8 h-8 text-gray-700 mb-3 animate-pulse" />
            <p className="text-sm text-gray-600">Loading reflections...</p>
          </div>
        ) : filteredEntries.length === 0 ? (
          <EmptyState hasEntries={entries.length > 0} />
        ) : (
          filteredEntries.map((entry) => (
            <JournalEntry
              key={entry.id}
              entry={entry}
              expanded={expandedId === entry.id}
              onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ─── Empty State ───────────────────────────────────────

function EmptyState({ hasEntries }: { hasEntries: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <BookOpen className="w-8 h-8 text-gray-700 mb-3" />
      {hasEntries ? (
        <>
          <p className="text-sm text-gray-500 mb-1">No matching reflections</p>
          <p className="text-xs text-gray-600">Try adjusting your search or category filter</p>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-500 mb-1">No reflections yet</p>
          <p className="text-xs text-gray-600">The Reflection Agent logs learnings, mistakes, and insights after each task</p>
        </>
      )}
    </div>
  )
}

// ─── Journal Entry ─────────────────────────────────────

interface JournalEntryProps {
  entry: MemoryEntry
  expanded: boolean
  onToggle: () => void
}

function JournalEntry({ entry, expanded, onToggle }: JournalEntryProps) {
  const category = categorizeEntry(entry)
  const style = CATEGORY_STYLE[category]

  return (
    <div
      className={`glass-card-hover transition-all duration-200 cursor-pointer ${
        expanded ? 'ring-1 ring-accent/20' : ''
      }`}
      onClick={onToggle}
    >
      <div className="p-4">
        {/* Top row: badge + content preview + expand toggle */}
        <div className="flex items-start gap-3">
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${style.bg} ${style.color} flex-shrink-0 mt-0.5`}>
            {style.label}
          </span>
          <div className="flex-1 min-w-0">
            <p className={`text-sm text-gray-300 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>
              {entry.content}
            </p>
          </div>
          {expanded
            ? <ChevronUp className="w-3.5 h-3.5 text-gray-600 flex-shrink-0 mt-1" />
            : <ChevronDown className="w-3.5 h-3.5 text-gray-600 flex-shrink-0 mt-1" />
          }
        </div>

        {/* Meta row — always visible */}
        <div className="flex items-center gap-3 mt-3 ml-[calc(0.5rem+2rem)]">
          <span className="text-[10px] text-gray-600">
            {formatDate(entry.createdAt)}
          </span>
          {entry.importance > 0 && (
            <ImportanceBar importance={entry.importance} />
          )}
          {!expanded && entry.tags.length > 0 && (
            <div className="flex items-center gap-1 ml-auto">
              <Tag className="w-2.5 h-2.5 text-gray-600" />
              <span className="text-[9px] text-gray-600">{entry.tags.length}</span>
            </div>
          )}
        </div>
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-white/[0.04] pt-3 space-y-3" onClick={(e) => e.stopPropagation()}>
          {/* Access stats */}
          <div className="flex items-center gap-4 text-[10px] text-gray-500">
            <span>Accessed {entry.accessCount} time{entry.accessCount !== 1 ? 's' : ''}</span>
            <span>Last accessed: {formatDate(entry.lastAccessed)}</span>
            <span>Importance: {Math.round(entry.importance * 100)}%</span>
          </div>

          {/* Full tags list */}
          {entry.tags.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <Tag className="w-3 h-3 text-gray-600" />
              {entry.tags.map((tag) => (
                <span key={tag} className="text-[9px] text-gray-500 bg-white/[0.04] px-1.5 py-0.5 rounded">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Full content (if it was clipped) */}
          {entry.content.length > 200 && (
            <div className="bg-white/[0.02] border border-white/[0.04] rounded-md p-3">
              <p className="text-xs text-gray-400 leading-relaxed whitespace-pre-wrap">{entry.content}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Importance Bar ────────────────────────────────────

function ImportanceBar({ importance }: { importance: number }) {
  const pct = Math.round(importance * 100)
  const barColor =
    pct >= 80 ? 'bg-green-400' :
    pct >= 50 ? 'bg-accent' :
    pct >= 25 ? 'bg-amber-400' :
    'bg-gray-500'

  return (
    <div className="flex items-center gap-1.5" title={`Importance: ${pct}%`}>
      <div className="w-12 h-1 bg-white/[0.06] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[9px] text-gray-600">{pct}%</span>
    </div>
  )
}

// ─── Helpers ───────────────────────────────────────────

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
