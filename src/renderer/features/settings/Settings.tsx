import { useState, useEffect, useCallback } from 'react'
import { Settings as SettingsIcon, Key, Cpu, Shield, Database, Save, Check, Loader2, Eye, EyeOff } from 'lucide-react'

type SettingsTab = 'general' | 'models' | 'rules' | 'storage'

const TABS: { id: SettingsTab; label: string; icon: typeof Key }[] = [
  { id: 'general', label: 'General', icon: SettingsIcon },
  { id: 'models', label: 'AI Models', icon: Cpu },
  { id: 'rules', label: 'Rules Engine', icon: Shield },
  { id: 'storage', label: 'Storage', icon: Database },
]

export function Settings() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <SettingsIcon className="w-5 h-5 text-gray-400" />
        <h2 className="text-lg font-semibold text-white">Settings</h2>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 bg-white/[0.02] rounded-lg w-fit">
        {TABS.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                flex items-center gap-2 px-4 py-2 rounded-md text-sm transition-all
                ${activeTab === tab.id
                  ? 'bg-accent/10 text-accent'
                  : 'text-gray-500 hover:text-gray-300'
                }
              `}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Content */}
      <div className="glass-card p-6">
        {activeTab === 'general' && <GeneralSettings />}
        {activeTab === 'models' && <ModelSettings />}
        {activeTab === 'rules' && <RulesSettings />}
        {activeTab === 'storage' && <StorageSettings />}
      </div>
    </div>
  )
}

// ─── Setting Panels ───

function GeneralSettings() {
  const [transparency, setTransparency] = useSetting<string>('ui_transparency', 'smart')
  const [maxAgents, setMaxAgents] = useSetting<number>('max_concurrent_agents', 3)

  return (
    <div className="space-y-6">
      <SettingRow
        label="UI Transparency Level"
        description="How much detail to show when agents are working"
      >
        <select
          value={transparency ?? 'smart'}
          onChange={(e) => setTransparency(e.target.value)}
          className="bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:border-accent/40"
        >
          <option value="smart">Smart Summary</option>
          <option value="verbose">Verbose</option>
          <option value="minimal">Minimal</option>
        </select>
      </SettingRow>

      <SettingRow
        label="Max Concurrent Agents"
        description="Number of worker threads for agent execution"
      >
        <input
          type="number"
          value={maxAgents ?? 3}
          onChange={(e) => setMaxAgents(Math.max(1, Math.min(8, Number(e.target.value))))}
          min={1}
          max={8}
          className="w-20 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white text-center focus:outline-none focus:border-accent/40"
        />
      </SettingRow>
    </div>
  )
}

function ModelSettings() {
  const [openrouterKey, setOpenrouterKey] = useSetting<string>('openrouter_api_key', '')
  const [replicateKey, setReplicateKey] = useSetting<string>('replicate_api_key', '')
  const [defaultModel, setDefaultModel] = useSetting<string>('default_model', 'anthropic/claude-sonnet-4-20250514')
  const [showOpenRouter, setShowOpenRouter] = useState(false)
  const [showReplicate, setShowReplicate] = useState(false)

  return (
    <div className="space-y-6">
      <SettingRow label="OpenRouter API Key" description="Required for LLM access">
        <div className="flex items-center gap-2">
          <input
            type={showOpenRouter ? 'text' : 'password'}
            value={openrouterKey ?? ''}
            onChange={(e) => setOpenrouterKey(e.target.value)}
            placeholder="sk-or-..."
            className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-accent/40"
          />
          <button onClick={() => setShowOpenRouter(!showOpenRouter)} className="text-gray-500 hover:text-gray-300">
            {showOpenRouter ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
          {openrouterKey && <Check className="w-4 h-4 text-green-400" />}
        </div>
      </SettingRow>

      <SettingRow label="Default Chat Model" description="Used by most agents">
        <input
          type="text"
          value={defaultModel ?? 'anthropic/claude-sonnet-4-20250514'}
          onChange={(e) => setDefaultModel(e.target.value)}
          className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:border-accent/40"
        />
      </SettingRow>

      <SettingRow label="Replicate API Key" description="For specialist models (optional)">
        <div className="flex items-center gap-2">
          <input
            type={showReplicate ? 'text' : 'password'}
            value={replicateKey ?? ''}
            onChange={(e) => setReplicateKey(e.target.value)}
            placeholder="r8_..."
            className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-accent/40"
          />
          <button onClick={() => setShowReplicate(!showReplicate)} className="text-gray-500 hover:text-gray-300">
            {showReplicate ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
          {replicateKey && <Check className="w-4 h-4 text-green-400" />}
        </div>
      </SettingRow>
    </div>
  )
}

function RulesSettings() {
  const [safetyRules, setSafetyRules] = useState<unknown>(null)
  const [proposals, setProposals] = useState<Array<{ id: string; rule: string; confidence: number }>>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rules, props] = await Promise.all([
        window.brainwave.getSafetyRules(),
        window.brainwave.getRuleProposals(),
      ])
      setSafetyRules(rules)
      setProposals(props as Array<{ id: string; rule: string; confidence: number }>)
    } catch (err) {
      console.error('Failed to load rules:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-white font-medium">Safety Rules</p>
          <p className="text-xs text-gray-500 mt-0.5">Hard limits — filesystem, shell, network restrictions</p>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full ${safetyRules ? 'bg-green-500/10 text-green-400' : 'bg-gray-500/10 text-gray-400'}`}>
          {loading ? 'Loading...' : safetyRules ? 'Active' : 'Not loaded'}
        </span>
      </div>

      <div className="border-t border-white/[0.04] pt-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm text-white font-medium">Pending Rule Proposals</p>
          <span className="text-[10px] bg-white/[0.04] px-1.5 py-0.5 rounded text-gray-500">{proposals.length}</span>
        </div>
        {proposals.length === 0 ? (
          <p className="text-xs text-gray-600">No pending proposals. The Reflection Agent will propose rules as it learns.</p>
        ) : (
          <div className="space-y-2">
            {proposals.map((p) => (
              <div key={p.id} className="flex items-center justify-between bg-white/[0.03] rounded-lg p-3">
                <div className="flex-1">
                  <p className="text-xs text-white">{p.rule}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">{Math.round(p.confidence * 100)}% confidence</p>
                </div>
                <div className="flex gap-2 ml-3">
                  <button
                    onClick={async () => { await window.brainwave.acceptRuleProposal(p.id); load() }}
                    className="text-[10px] px-2 py-1 rounded bg-green-500/10 text-green-400 hover:bg-green-500/20"
                  >
                    Accept
                  </button>
                  <button
                    onClick={async () => { await window.brainwave.dismissRuleProposal(p.id); load() }}
                    className="text-[10px] px-2 py-1 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={async () => { await window.brainwave.reloadRules(); load() }}
        className="text-xs text-gray-500 hover:text-white transition-colors"
      >
        Reload rules from disk
      </button>
    </div>
  )
}

function StorageSettings() {
  const [stats, setStats] = useState<{ episodic: number; semantic: number; procedural: number; prospective: number; people: number } | null>(null)

  useEffect(() => {
    window.brainwave.getMemoryStats().then(setStats).catch(console.error)
  }, [])

  const totalMemories = stats ? stats.episodic + stats.semantic + stats.procedural + stats.prospective + stats.people : 0

  return (
    <div className="space-y-6">
      <SettingRow label="Database Location" description="SQLite database file path">
        <span className="text-sm text-gray-400 font-mono">~/.brainwave2/brain.db</span>
      </SettingRow>

      <SettingRow label="Total Memories" description="Across all memory subsystems">
        <span className="text-sm text-white font-medium">{totalMemories}</span>
      </SettingRow>

      {stats && (
        <div className="grid grid-cols-5 gap-3 pt-2">
          {Object.entries(stats).map(([key, val]) => (
            <div key={key} className="text-center">
              <p className="text-lg font-bold text-white">{val}</p>
              <p className="text-[10px] text-gray-500 capitalize">{key}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Custom Hook: Persisted setting ───

function useSetting<T>(key: string, defaultValue: T): [T | null, (value: T) => void] {
  const [value, setValue] = useState<T | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.brainwave.getSetting<T>(key).then((v) => {
      setValue(v ?? defaultValue)
      setLoaded(true)
    }).catch(() => {
      setValue(defaultValue)
      setLoaded(true)
    })
  }, [key, defaultValue])

  const update = useCallback((newValue: T) => {
    setValue(newValue)
    window.brainwave.setSetting(key, newValue).catch(console.error)
  }, [key])

  return [loaded ? value : defaultValue, update]
}

// ─── Reusable Setting Row ───

function SettingRow({ label, description, children }: {
  label: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm text-white font-medium">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
      </div>
      {children}
    </div>
  )
}
