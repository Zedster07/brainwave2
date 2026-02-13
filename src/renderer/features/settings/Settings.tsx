import { useState, useEffect, useCallback } from 'react'
import { Settings as SettingsIcon, Key, Cpu, Shield, Database, Save, Check, Loader2, Eye, EyeOff, Zap, Activity, Wallet } from 'lucide-react'

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
  const [modelMode, setModelMode] = useState<string>('normal')
  const [agentConfigs, setAgentConfigs] = useState<Record<string, { provider: string; model: string }> | null>(null)
  const [modeLoading, setModeLoading] = useState(false)

  // Load current mode and agent configs on mount
  useEffect(() => {
    window.brainwave.getModelMode().then(setModelMode).catch(console.error)
    window.brainwave.getModelConfigs().then(setAgentConfigs).catch(console.error)
  }, [])

  const handleModeChange = useCallback(async (mode: string) => {
    setModeLoading(true)
    try {
      await window.brainwave.setModelMode(mode)
      setModelMode(mode)
      const configs = await window.brainwave.getModelConfigs()
      setAgentConfigs(configs)
    } catch (err) {
      console.error('Failed to set model mode:', err)
    } finally {
      setModeLoading(false)
    }
  }, [])

  const MODE_INFO = [
    { id: 'beast', label: 'Beast', icon: Zap, color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20', desc: 'Max quality — Opus 4.6, Sonnet 4.5, Gemini Pro' },
    { id: 'normal', label: 'Normal', icon: Activity, color: 'text-accent', bg: 'bg-accent/10 border-accent/20', desc: 'Balanced — Sonnet 4, Gemini Pro/Flash, Haiku' },
    { id: 'economy', label: 'Economy', icon: Wallet, color: 'text-green-400', bg: 'bg-green-500/10 border-green-500/20', desc: 'Budget — DeepSeek, Qwen, GPT-4.1 Mini/Nano' },
  ]

  return (
    <div className="space-y-6">
      {/* Model Mode Selector */}
      <div>
        <p className="text-sm text-white font-medium mb-1">Agent Model Mode</p>
        <p className="text-xs text-gray-500 mb-3">
          Choose a preset that assigns different models to each agent based on cost/quality.
          {openrouterKey && replicateKey && ' Both API keys set — automatic provider failover is active.'}
        </p>
        <div className="grid grid-cols-3 gap-3">
          {MODE_INFO.map((m) => {
            const Icon = m.icon
            const isActive = modelMode === m.id
            return (
              <button
                key={m.id}
                onClick={() => handleModeChange(m.id)}
                disabled={modeLoading}
                className={`
                  flex flex-col items-center gap-2 p-4 rounded-lg border transition-all text-center
                  ${isActive
                    ? `${m.bg} border-opacity-100`
                    : 'bg-white/[0.02] border-white/[0.06] hover:border-white/[0.12]'
                  }
                `}
              >
                <Icon className={`w-5 h-5 ${isActive ? m.color : 'text-gray-500'}`} />
                <span className={`text-sm font-medium ${isActive ? 'text-white' : 'text-gray-400'}`}>
                  {m.label}
                </span>
                <span className="text-[10px] text-gray-500 leading-tight">{m.desc}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Current Agent Assignments */}
      {agentConfigs && (
        <div>
          <p className="text-xs text-gray-500 mb-2">Current agent → model assignments:</p>
          <div className="grid grid-cols-2 gap-1.5">
            {Object.entries(agentConfigs).map(([agent, config]) => (
              <div key={agent} className="flex items-center justify-between bg-white/[0.03] rounded px-3 py-1.5">
                <span className="text-[11px] text-gray-400 capitalize">{agent}</span>
                <span className="text-[10px] text-gray-500 font-mono truncate ml-2 max-w-[180px]">{config.model}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-white/[0.04] pt-4 space-y-6">
        <SettingRow label="OpenRouter API Key" description="Primary LLM provider">
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

        <SettingRow label="Replicate API Key" description="Fallback provider — used if OpenRouter fails">
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

        <SettingRow label="Default Chat Model" description="Override for agents without preset assignment">
          <input
            type="text"
            value={defaultModel ?? 'anthropic/claude-sonnet-4-20250514'}
            onChange={(e) => setDefaultModel(e.target.value)}
            className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:border-accent/40"
          />
        </SettingRow>
      </div>
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
