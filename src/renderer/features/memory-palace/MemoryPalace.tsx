import { useState, useEffect, useCallback } from 'react'
import {
  Brain,
  Search,
  Database,
  Users,
  Clock,
  Target,
  Workflow,
  AlertCircle,
  Trash2,
  ChevronRight,
  RefreshCw,
  CheckCircle,
  XCircle,
  Star,
} from 'lucide-react'
import type {
  MemoryEntry,
  MemoryStatsInfo,
  PersonEntry,
  ProceduralEntry,
  ProspectiveEntry,
} from '@shared/types'

// ─── Tab Types ──────────────────────────────────────────────

type MemoryTab = 'overview' | 'episodic' | 'semantic' | 'procedural' | 'prospective' | 'people'

const TABS: Array<{ id: MemoryTab; label: string; icon: typeof Brain; color: string }> = [
  { id: 'overview', label: 'Overview', icon: Brain, color: 'text-accent' },
  { id: 'episodic', label: 'Episodic', icon: Clock, color: 'text-blue-400' },
  { id: 'semantic', label: 'Semantic', icon: Database, color: 'text-emerald-400' },
  { id: 'procedural', label: 'Procedural', icon: Workflow, color: 'text-amber-400' },
  { id: 'prospective', label: 'Prospective', icon: Target, color: 'text-purple-400' },
  { id: 'people', label: 'People', icon: Users, color: 'text-rose-400' },
]

// ─── Main Component ─────────────────────────────────────────

export function MemoryPalace() {
  const [activeTab, setActiveTab] = useState<MemoryTab>('overview')
  const [stats, setStats] = useState<MemoryStatsInfo | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const loadStats = useCallback(async () => {
    try {
      const s = await window.brainwave.getMemoryStats()
      setStats(s)
    } catch (err) {
      console.error('Failed to load memory stats:', err)
    }
  }, [])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <Brain className="w-5 h-5 text-accent" />
          <h2 className="text-lg font-semibold text-white">Memory Palace</h2>
        </div>
        <button
          onClick={loadStats}
          className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-400 hover:text-white glass-card-hover"
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 overflow-x-auto pb-1">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-all
                ${isActive ? 'bg-white/[0.08] text-white border border-white/[0.1]' : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]'}
              `}
            >
              <Icon className={`w-3.5 h-3.5 ${isActive ? tab.color : ''}`} />
              {tab.label}
              {stats && tab.id !== 'overview' && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isActive ? 'bg-white/10' : 'bg-white/5'}`}>
                  {stats[tab.id === 'people' ? 'people' : tab.id] ?? 0}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'overview' && <OverviewPanel stats={stats} onNavigate={setActiveTab} />}
        {activeTab === 'episodic' && <EpisodicPanel searchQuery={searchQuery} setSearchQuery={setSearchQuery} />}
        {activeTab === 'semantic' && <SemanticPanel searchQuery={searchQuery} setSearchQuery={setSearchQuery} />}
        {activeTab === 'procedural' && <ProceduralPanel />}
        {activeTab === 'prospective' && <ProspectivePanel />}
        {activeTab === 'people' && <PeoplePanel />}
      </div>
    </div>
  )
}

// ─── Overview Panel ─────────────────────────────────────────

function OverviewPanel({ stats, onNavigate }: { stats: MemoryStatsInfo | null; onNavigate: (tab: MemoryTab) => void }) {
  const cards = [
    { id: 'episodic' as MemoryTab, label: 'Episodic', desc: 'Task experiences & outcomes', count: stats?.episodic ?? 0, icon: Clock, color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
    { id: 'semantic' as MemoryTab, label: 'Semantic', desc: 'Facts & learned knowledge', count: stats?.semantic ?? 0, icon: Database, color: 'text-emerald-400', bgColor: 'bg-emerald-500/10' },
    { id: 'procedural' as MemoryTab, label: 'Procedural', desc: 'How-to patterns & workflows', count: stats?.procedural ?? 0, icon: Workflow, color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
    { id: 'prospective' as MemoryTab, label: 'Prospective', desc: 'Future intentions & reminders', count: stats?.prospective ?? 0, icon: Target, color: 'text-purple-400', bgColor: 'bg-purple-500/10' },
    { id: 'people' as MemoryTab, label: 'People', desc: 'People knowledge graph', count: stats?.people ?? 0, icon: Users, color: 'text-rose-400', bgColor: 'bg-rose-500/10' },
  ]

  const totalMemories = cards.reduce((sum, c) => sum + c.count, 0)

  return (
    <div>
      {/* Total */}
      <div className="glass-card p-5 mb-5">
        <div className="flex items-center gap-3 mb-1">
          <Brain className="w-5 h-5 text-accent" />
          <span className="text-sm text-gray-400">Total Memories</span>
        </div>
        <p className="text-3xl font-bold text-white ml-8">{totalMemories}</p>
      </div>

      {/* Memory type cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((card) => {
          const Icon = card.icon
          return (
            <button
              key={card.id}
              onClick={() => onNavigate(card.id)}
              className="glass-card-hover p-4 text-left group"
            >
              <div className="flex items-center justify-between mb-3">
                <div className={`w-9 h-9 rounded-lg ${card.bgColor} flex items-center justify-center`}>
                  <Icon className={`w-4.5 h-4.5 ${card.color}`} />
                </div>
                <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-gray-400 transition-colors" />
              </div>
              <h3 className="text-sm font-medium text-white mb-1">{card.label}</h3>
              <p className="text-[11px] text-gray-500 mb-3">{card.desc}</p>
              <p className="text-2xl font-bold text-white">{card.count}</p>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Episodic Panel ─────────────────────────────────────────

function EpisodicPanel({ searchQuery, setSearchQuery }: { searchQuery: string; setSearchQuery: (q: string) => void }) {
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (searchQuery.trim()) {
        const results = await window.brainwave.queryMemory({ query: searchQuery, type: 'episodic', limit: 50 })
        setMemories(results)
      } else {
        const recent = await window.brainwave.getRecentMemories(50)
        setMemories(recent)
      }
    } catch (err) {
      console.error('Failed to load episodic memories:', err)
    } finally {
      setLoading(false)
    }
  }, [searchQuery])

  useEffect(() => { load() }, [load])

  return (
    <div>
      <SearchBar query={searchQuery} onChange={setSearchQuery} placeholder="Search episodic memories..." />

      {loading ? (
        <LoadingState />
      ) : memories.length === 0 ? (
        <EmptyState message="No episodic memories yet. Memories form as Brainwave completes tasks." />
      ) : (
        <div className="space-y-2 mt-4">
          {memories.map((mem) => (
            <MemoryCard key={mem.id} memory={mem} onDelete={async () => {
              await window.brainwave.deleteMemory(mem.id, 'episodic')
              load()
            }} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Semantic Panel ─────────────────────────────────────────

function SemanticPanel({ searchQuery, setSearchQuery }: { searchQuery: string; setSearchQuery: (q: string) => void }) {
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (searchQuery.trim()) {
        const results = await window.brainwave.queryMemory({ query: searchQuery, type: 'semantic', limit: 50 })
        setMemories(results)
      } else {
        const results = await window.brainwave.queryMemory({ query: '*', type: 'semantic', limit: 50 })
        setMemories(results)
      }
    } catch (err) {
      console.error('Failed to load semantic memories:', err)
    } finally {
      setLoading(false)
    }
  }, [searchQuery])

  useEffect(() => { load() }, [load])

  return (
    <div>
      <SearchBar query={searchQuery} onChange={setSearchQuery} placeholder="Search facts & knowledge..." />

      {loading ? (
        <LoadingState />
      ) : memories.length === 0 ? (
        <EmptyState message="No semantic memories yet. Knowledge accumulates as Brainwave learns." />
      ) : (
        <div className="space-y-2 mt-4">
          {memories.map((mem) => (
            <MemoryCard key={mem.id} memory={mem} onDelete={async () => {
              await window.brainwave.deleteMemory(mem.id, 'semantic')
              load()
            }} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Procedural Panel ───────────────────────────────────────

function ProceduralPanel() {
  const [procedures, setProcedures] = useState<ProceduralEntry[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const all = await window.brainwave.getAllProcedures()
      setProcedures(all)
    } catch (err) {
      console.error('Failed to load procedures:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div>
      {loading ? (
        <LoadingState />
      ) : procedures.length === 0 ? (
        <EmptyState message="No learned procedures yet. Procedures emerge from successful task patterns." />
      ) : (
        <div className="space-y-2">
          {procedures.map((proc) => (
            <div key={proc.id} className="glass-card p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Workflow className="w-4 h-4 text-amber-400" />
                  <h3 className="text-sm font-medium text-white">{proc.name}</h3>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-gray-500">
                    {Math.round(proc.successRate * 100)}% success
                  </span>
                  <span className="text-[10px] text-gray-600">
                    {proc.executionCount} runs
                  </span>
                  <button
                    onClick={async () => {
                      await window.brainwave.deleteProcedure(proc.id)
                      load()
                    }}
                    className="text-gray-600 hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {proc.description && (
                <p className="text-xs text-gray-500 mb-2">{proc.description}</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {proc.steps.map((step, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-400/80"
                  >
                    {i + 1}. {step.action.slice(0, 40)}
                  </span>
                ))}
              </div>
              {proc.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {proc.tags.map((tag) => (
                    <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-500">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Prospective Panel ──────────────────────────────────────

function ProspectivePanel() {
  const [entries, setEntries] = useState<ProspectiveEntry[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const all = await window.brainwave.getAllProspective()
      setEntries(all)
    } catch (err) {
      console.error('Failed to load prospective memories:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const statusIcon = (status: string) => {
    switch (status) {
      case 'pending': return <Clock className="w-3.5 h-3.5 text-yellow-400" />
      case 'triggered': return <AlertCircle className="w-3.5 h-3.5 text-blue-400" />
      case 'completed': return <CheckCircle className="w-3.5 h-3.5 text-green-400" />
      case 'expired': return <XCircle className="w-3.5 h-3.5 text-gray-500" />
      default: return null
    }
  }

  return (
    <div>
      {loading ? (
        <LoadingState />
      ) : entries.length === 0 ? (
        <EmptyState message="No prospective memories yet. Future intentions and reminders will appear here." />
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div key={entry.id} className="glass-card p-4">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  {statusIcon(entry.status)}
                  <h3 className="text-sm font-medium text-white">{entry.intention}</h3>
                </div>
                <div className="flex items-center gap-2">
                  {entry.status === 'pending' && (
                    <button
                      onClick={async () => {
                        await window.brainwave.completeProspective(entry.id)
                        load()
                      }}
                      className="text-[10px] px-2 py-1 rounded bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors"
                    >
                      Complete
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      await window.brainwave.deleteProspective(entry.id)
                      load()
                    }}
                    className="text-gray-600 hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-3 mt-2 text-[10px] text-gray-500">
                <span className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400/80">
                  {entry.triggerType}
                </span>
                <span>{entry.triggerValue}</span>
                {entry.dueAt && <span>Due: {new Date(entry.dueAt).toLocaleString()}</span>}
                <span className="flex items-center gap-1">
                  <Star className="w-3 h-3" />
                  {Math.round(entry.priority * 100)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── People Panel ───────────────────────────────────────────

function PeoplePanel() {
  const [people, setPeople] = useState<PersonEntry[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (searchQuery.trim()) {
        const results = await window.brainwave.searchPeople(searchQuery)
        setPeople(results)
      } else {
        const all = await window.brainwave.getAllPeople()
        setPeople(all)
      }
    } catch (err) {
      console.error('Failed to load people:', err)
    } finally {
      setLoading(false)
    }
  }, [searchQuery])

  useEffect(() => { load() }, [load])

  return (
    <div>
      <SearchBar query={searchQuery} onChange={setSearchQuery} placeholder="Search people..." />

      {loading ? (
        <LoadingState />
      ) : people.length === 0 ? (
        <EmptyState message="No people in the knowledge graph yet. People are learned from task context." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
          {people.map((person) => (
            <div key={person.id} className="glass-card p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-rose-500/10 flex items-center justify-center">
                    <span className="text-sm font-bold text-rose-400">
                      {person.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-white">
                      {person.name}
                      {person.nickname && person.nickname !== person.name && (
                        <span className="text-gray-500 font-normal ml-1">({person.nickname})</span>
                      )}
                    </h3>
                    {person.fullName && person.fullName !== person.name && (
                      <p className="text-[10px] text-gray-500">{person.fullName}</p>
                    )}
                    {person.relationship && (
                      <p className="text-[10px] text-gray-500">{person.relationship}</p>
                    )}
                  </div>
                </div>
                <button
                  onClick={async () => {
                    await window.brainwave.deletePerson(person.id)
                    load()
                  }}
                  className="text-gray-600 hover:text-red-400 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Personal details */}
              {(person.occupation || person.company || person.email || person.phone || person.address || person.age || person.birthday || person.gender) && (
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-2 text-[10px]">
                  {person.occupation && (
                    <p className="text-gray-500"><span className="text-gray-600">Job:</span> {person.occupation}{person.company ? ` @ ${person.company}` : ''}</p>
                  )}
                  {!person.occupation && person.company && (
                    <p className="text-gray-500"><span className="text-gray-600">Company:</span> {person.company}</p>
                  )}
                  {person.email && (
                    <p className="text-gray-500 truncate"><span className="text-gray-600">Email:</span> {person.email}</p>
                  )}
                  {person.phone && (
                    <p className="text-gray-500"><span className="text-gray-600">Phone:</span> {person.phone}</p>
                  )}
                  {person.address && (
                    <p className="text-gray-500"><span className="text-gray-600">Location:</span> {person.address}</p>
                  )}
                  {person.age != null && (
                    <p className="text-gray-500"><span className="text-gray-600">Age:</span> {person.age}</p>
                  )}
                  {person.birthday && (
                    <p className="text-gray-500"><span className="text-gray-600">Birthday:</span> {person.birthday}</p>
                  )}
                  {person.gender && (
                    <p className="text-gray-500"><span className="text-gray-600">Gender:</span> {person.gender}</p>
                  )}
                </div>
              )}

              {/* Social links */}
              {person.socialLinks && Object.keys(person.socialLinks).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {Object.entries(person.socialLinks).map(([platform, url]) => (
                    <span key={platform} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400/80 cursor-pointer hover:bg-blue-500/20"
                      onClick={() => window.open(url, '_blank')}
                    >
                      {platform}
                    </span>
                  ))}
                </div>
              )}

              {person.traits.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {person.traits.map((trait) => (
                    <span key={trait} className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400/80">
                      {trait}
                    </span>
                  ))}
                </div>
              )}

              {person.notes && (
                <p className="text-[10px] text-gray-500 mt-2 italic">{person.notes}</p>
              )}

              {person.lastInteraction && (
                <p className="text-[10px] text-gray-600 mt-2">
                  Last interaction: {new Date(person.lastInteraction).toLocaleDateString()}
                </p>
              )}

              {person.interactionHistory.length > 0 && (
                <div className="mt-2 border-t border-white/[0.04] pt-2">
                  <p className="text-[10px] text-gray-600 mb-1">Recent interactions</p>
                  {person.interactionHistory.slice(-3).reverse().map((int, i) => (
                    <p key={i} className="text-[10px] text-gray-500 truncate">
                      <span className="text-gray-600">{int.type}</span> — {int.summary}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Shared Components ──────────────────────────────────────

function SearchBar({ query, onChange, placeholder }: { query: string; onChange: (q: string) => void; placeholder: string }) {
  return (
    <div className="glass-card flex items-center gap-3 px-4 py-2.5">
      <Search className="w-4 h-4 text-gray-500 flex-shrink-0" />
      <input
        type="text"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-transparent text-sm text-white placeholder:text-gray-600 focus:outline-none"
      />
      {query && (
        <button onClick={() => onChange('')} className="text-gray-500 hover:text-gray-300">
          <XCircle className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}

function MemoryCard({ memory, onDelete }: { memory: MemoryEntry; onDelete: () => void }) {
  const importanceColor =
    memory.importance >= 0.7 ? 'text-emerald-400' :
    memory.importance >= 0.4 ? 'text-yellow-400' :
    'text-gray-500'

  return (
    <div className="glass-card p-4 group">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white leading-relaxed">{memory.content}</p>
          <div className="flex items-center gap-3 mt-2 text-[10px] text-gray-500">
            <span className={`font-medium ${importanceColor}`}>
              {Math.round(memory.importance * 100)}% importance
            </span>
            <span>{new Date(memory.createdAt).toLocaleDateString()}</span>
            <span>{memory.accessCount} accesses</span>
          </div>
          {memory.tags && (memory.tags as string[]).length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {(memory.tags as string[]).map((tag) => (
                <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-500">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={onDelete}
          className="text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="glass-card p-8 mt-4 text-center">
      <Brain className="w-8 h-8 text-gray-700 mx-auto mb-3" />
      <p className="text-sm text-gray-500">{message}</p>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="glass-card p-8 mt-4 text-center">
      <RefreshCw className="w-6 h-6 text-gray-600 mx-auto mb-3 animate-spin" />
      <p className="text-sm text-gray-600">Loading memories...</p>
    </div>
  )
}
