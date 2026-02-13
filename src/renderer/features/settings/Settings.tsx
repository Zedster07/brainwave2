import { useState, useEffect, useCallback } from 'react'
import { Settings as SettingsIcon, Key, Cpu, Shield, Database, Save, Check, Loader2, Eye, EyeOff, Zap, Activity, Wallet, Download, Upload, Monitor, Wifi, WifiOff, RefreshCw, ArrowDownCircle, Plug, Plus, Trash2, Power, PowerOff, Pencil, X } from 'lucide-react'
import type { PluginInfoData } from '@shared/types'

type SettingsTab = 'general' | 'models' | 'rules' | 'storage' | 'plugins'

const TABS: { id: SettingsTab; label: string; icon: typeof Key }[] = [
  { id: 'general', label: 'General', icon: SettingsIcon },
  { id: 'models', label: 'AI Models', icon: Cpu },
  { id: 'rules', label: 'Rules Engine', icon: Shield },
  { id: 'storage', label: 'Storage', icon: Database },
  { id: 'plugins', label: 'Plugins', icon: Plug },
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
        {activeTab === 'plugins' && <PluginSettings />}
      </div>
    </div>
  )
}

// ─── Setting Panels ───

function GeneralSettings() {
  const [transparency, setTransparency] = useSetting<string>('ui_transparency', 'smart')
  const [maxAgents, setMaxAgents] = useSetting<number>('max_concurrent_agents', 3)
  const [updateStatus, setUpdateStatus] = useState<{ state: string; version?: string; progress?: number; error?: string }>({ state: 'idle' })

  useEffect(() => {
    window.brainwave.getUpdateStatus().then(setUpdateStatus).catch(console.error)
    const unsub = window.brainwave.onUpdateStatus(setUpdateStatus)
    return unsub
  }, [])

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

      {/* Auto-Update Section */}
      <div className="border-t border-white/[0.04] pt-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-white font-medium">App Updates</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {updateStatus.state === 'available' && updateStatus.version
                ? `v${updateStatus.version} available`
                : updateStatus.state === 'downloaded' && updateStatus.version
                  ? `v${updateStatus.version} ready to install`
                  : updateStatus.state === 'downloading'
                    ? `Downloading... ${updateStatus.progress ?? 0}%`
                    : updateStatus.state === 'checking'
                      ? 'Checking for updates...'
                      : updateStatus.state === 'error'
                        ? `Error: ${updateStatus.error}`
                        : 'App is up to date'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {updateStatus.state === 'downloading' && (
              <div className="w-24 h-1.5 bg-white/[0.05] rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all duration-300"
                  style={{ width: `${updateStatus.progress ?? 0}%` }}
                />
              </div>
            )}
            {updateStatus.state === 'available' && (
              <button
                onClick={() => window.brainwave.downloadUpdate()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent/10 text-accent rounded-md hover:bg-accent/20 transition-colors"
              >
                <ArrowDownCircle className="w-3.5 h-3.5" />
                Download
              </button>
            )}
            {updateStatus.state === 'downloaded' && (
              <button
                onClick={() => window.brainwave.installUpdate()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-green-500/10 text-green-400 rounded-md hover:bg-green-500/20 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Install & Restart
              </button>
            )}
            {(updateStatus.state === 'idle' || updateStatus.state === 'not-available' || updateStatus.state === 'error') && (
              <button
                onClick={() => window.brainwave.checkForUpdate()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white/[0.05] text-gray-400 rounded-md hover:bg-white/[0.08] transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Check Now
              </button>
            )}
            {updateStatus.state === 'checking' && (
              <Loader2 className="w-4 h-4 text-accent animate-spin" />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ModelSettings() {
  const [openrouterKey, setOpenrouterKey] = useSetting<string>('openrouter_api_key', '')
  const [replicateKey, setReplicateKey] = useSetting<string>('replicate_api_key', '')
  const [defaultModel, setDefaultModel] = useSetting<string>('default_model', 'anthropic/claude-sonnet-4-20250514')
  const [ollamaHost, setOllamaHost] = useSetting<string>('ollama_host', 'http://localhost:11434')
  const [ollamaModel, setOllamaModel] = useSetting<string>('ollama_default_model', 'llama3.1')
  const [showOpenRouter, setShowOpenRouter] = useState(false)
  const [showReplicate, setShowReplicate] = useState(false)
  const [modelMode, setModelMode] = useState<string>('normal')
  const [agentConfigs, setAgentConfigs] = useState<Record<string, { provider: string; model: string }> | null>(null)
  const [modeLoading, setModeLoading] = useState(false)
  const [ollamaStatus, setOllamaStatus] = useState<'unknown' | 'checking' | 'online' | 'offline'>('unknown')
  const [ollamaModels, setOllamaModels] = useState<Array<{ name: string; size: number }>>([]) 

  // Load current mode and agent configs on mount
  useEffect(() => {
    window.brainwave.getModelMode().then(setModelMode).catch(console.error)
    window.brainwave.getModelConfigs().then(setAgentConfigs).catch(console.error)
    // Auto-check Ollama status
    checkOllamaStatus()
  }, [])

  const checkOllamaStatus = useCallback(async () => {
    setOllamaStatus('checking')
    try {
      const host = ollamaHost || 'http://localhost:11434'
      const healthy = await window.brainwave.ollamaHealthCheck(host)
      setOllamaStatus(healthy ? 'online' : 'offline')
      if (healthy) {
        const models = await window.brainwave.ollamaListModels(host)
        setOllamaModels(models)
      }
    } catch {
      setOllamaStatus('offline')
    }
  }, [ollamaHost])

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
    { id: 'local', label: 'Local', icon: Monitor, color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/20', desc: 'Offline — Ollama local models, free & private' },
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
        <div className="grid grid-cols-4 gap-3">
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

      {/* Ollama (Local LLM) Section */}
      <div className="border-t border-white/[0.04] pt-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-white font-medium">Ollama (Local LLM)</p>
            <p className="text-xs text-gray-500 mt-0.5">Run models locally — fully offline, free, private</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`flex items-center gap-1.5 text-xs ${
              ollamaStatus === 'online' ? 'text-green-400' :
              ollamaStatus === 'offline' ? 'text-red-400' :
              ollamaStatus === 'checking' ? 'text-yellow-400' : 'text-gray-500'
            }`}>
              {ollamaStatus === 'online' ? <Wifi className="w-3.5 h-3.5" /> :
               ollamaStatus === 'offline' ? <WifiOff className="w-3.5 h-3.5" /> :
               ollamaStatus === 'checking' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {ollamaStatus === 'online' ? 'Connected' :
               ollamaStatus === 'offline' ? 'Offline' :
               ollamaStatus === 'checking' ? 'Checking...' : 'Unknown'}
            </span>
            <button
              onClick={checkOllamaStatus}
              className="text-gray-500 hover:text-gray-300 transition-colors"
              title="Test connection"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${ollamaStatus === 'checking' ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <SettingRow label="Host URL" description="Ollama server address (default: localhost:11434)">
          <input
            type="text"
            value={ollamaHost ?? 'http://localhost:11434'}
            onChange={(e) => setOllamaHost(e.target.value)}
            placeholder="http://localhost:11434"
            className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-accent/40"
          />
        </SettingRow>

        <SettingRow label="Default Model" description={`${ollamaModels.length} model(s) available`}>
          {ollamaModels.length > 0 ? (
            <select
              value={ollamaModel ?? 'llama3.1'}
              onChange={(e) => setOllamaModel(e.target.value)}
              className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:border-accent/40"
            >
              {ollamaModels.map((m) => (
                <option key={m.name} value={m.name} className="bg-gray-800">
                  {m.name} ({(m.size / 1e9).toFixed(1)}GB)
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={ollamaModel ?? 'llama3.1'}
              onChange={(e) => setOllamaModel(e.target.value)}
              placeholder="llama3.1"
              className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-accent/40"
            />
          )}
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
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const [importStatus, setImportStatus] = useState<string | null>(null)

  useEffect(() => {
    window.brainwave.getMemoryStats().then(setStats).catch(console.error)
  }, [])

  const totalMemories = stats ? stats.episodic + stats.semantic + stats.procedural + stats.prospective + stats.people : 0

  const handleExport = async () => {
    setExportStatus('Exporting...')
    try {
      const result = await window.brainwave.exportMemories()
      if (result.success) {
        setExportStatus(`Exported ${result.count} memories`)
      } else {
        setExportStatus(result.error === 'Cancelled' ? null : `Error: ${result.error}`)
      }
    } catch (err) {
      setExportStatus(`Error: ${err}`)
    }
    setTimeout(() => setExportStatus(null), 4000)
  }

  const handleImport = async () => {
    setImportStatus('Importing...')
    try {
      const result = await window.brainwave.importMemories()
      if (result.success) {
        setImportStatus(`Imported ${result.imported}, skipped ${result.skipped}`)
        // Refresh stats
        window.brainwave.getMemoryStats().then(setStats).catch(console.error)
      } else {
        setImportStatus(result.error === 'Cancelled' ? null : `Error: ${result.error}`)
      }
    } catch (err) {
      setImportStatus(`Error: ${err}`)
    }
    setTimeout(() => setImportStatus(null), 4000)
  }

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

      {/* Export / Import */}
      <div className="border-t border-white/[0.06] pt-4">
        <p className="text-sm text-white font-medium mb-1">Memory Export / Import</p>
        <p className="text-xs text-gray-500 mb-3">Transfer memories between Brainwave instances as JSON</p>
        <div className="flex items-center gap-3">
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-3 py-2 bg-accent/10 text-accent text-xs rounded-lg hover:bg-accent/20 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export All
          </button>
          <button
            onClick={handleImport}
            className="flex items-center gap-2 px-3 py-2 bg-white/[0.04] text-gray-300 text-xs rounded-lg hover:bg-white/[0.06] transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            Import
          </button>
          {exportStatus && <span className="text-[10px] text-accent">{exportStatus}</span>}
          {importStatus && <span className="text-[10px] text-accent">{importStatus}</span>}
        </div>
      </div>
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

// ─── Plugin Settings ───

interface PluginFormState {
  name: string
  version: string
  description: string
  author: string
  agentType: string
  capabilities: string
  systemPrompt: string
  icon: string
}

const emptyForm: PluginFormState = {
  name: '',
  version: '1.0.0',
  description: '',
  author: '',
  agentType: '',
  capabilities: '',
  systemPrompt: '',
  icon: '🔌',
}

function PluginSettings() {
  const [plugins, setPlugins] = useState<PluginInfoData[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<PluginFormState>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadPlugins = useCallback(async () => {
    try {
      const list = await window.brainwave.pluginList()
      setPlugins(list)
    } catch (err) {
      console.error('[PluginSettings] Failed to load plugins:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadPlugins() }, [loadPlugins])

  const openNew = () => {
    setForm(emptyForm)
    setEditingId(null)
    setError(null)
    setShowForm(true)
  }

  const openEdit = (plugin: PluginInfoData) => {
    setForm({
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      author: plugin.author ?? '',
      agentType: plugin.agentType,
      capabilities: plugin.capabilities.join(', '),
      systemPrompt: plugin.systemPrompt,
      icon: plugin.icon ?? '🔌',
    })
    setEditingId(plugin.id)
    setError(null)
    setShowForm(true)
  }

  const handleSave = async () => {
    setError(null)
    setSaving(true)
    try {
      const manifest = {
        name: form.name.trim(),
        version: form.version.trim(),
        description: form.description.trim(),
        author: form.author.trim() || undefined,
        agentType: form.agentType.trim().toLowerCase().replace(/\s+/g, '-'),
        capabilities: form.capabilities.split(',').map((c) => c.trim()).filter(Boolean),
        systemPrompt: form.systemPrompt.trim(),
        icon: form.icon.trim() || '🔌',
      }

      if (editingId) {
        await window.brainwave.pluginUpdate(editingId, manifest)
      } else {
        await window.brainwave.pluginInstall(manifest)
      }

      setShowForm(false)
      setEditingId(null)
      await loadPlugins()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save plugin')
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (id: string) => {
    await window.brainwave.pluginRemove(id)
    await loadPlugins()
  }

  const handleToggle = async (plugin: PluginInfoData) => {
    if (plugin.enabled) {
      await window.brainwave.pluginDisable(plugin.id)
    } else {
      await window.brainwave.pluginEnable(plugin.id)
    }
    await loadPlugins()
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading plugins…</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Custom Agent Plugins</h3>
          <p className="text-xs text-gray-500 mt-1">Create custom agents with their own system prompts and capabilities</p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/10 text-accent text-xs font-medium hover:bg-accent/20 transition-all"
        >
          <Plus className="w-3.5 h-3.5" /> New Plugin
        </button>
      </div>

      {/* Plugin list */}
      {plugins.length === 0 && !showForm && (
        <div className="text-center py-8 text-gray-600 text-sm">
          No plugins installed. Click "New Plugin" to create a custom agent.
        </div>
      )}

      {plugins.map((plugin) => (
        <div key={plugin.id} className="flex items-center gap-3 p-3 bg-white/[0.02] rounded-lg border border-white/[0.06]">
          <span className="text-lg">{plugin.icon ?? '🔌'}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-white truncate">{plugin.name}</p>
              <span className="text-[10px] text-gray-600">v{plugin.version}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${plugin.enabled ? 'bg-green-500/10 text-green-400' : 'bg-gray-500/10 text-gray-500'}`}>
                {plugin.enabled ? 'active' : 'disabled'}
              </span>
            </div>
            <p className="text-xs text-gray-500 truncate mt-0.5">{plugin.description}</p>
            <p className="text-[10px] text-gray-600 mt-0.5">
              Type: <span className="text-gray-400">{plugin.agentType}</span>
              {' · '}
              Capabilities: <span className="text-gray-400">{plugin.capabilities.join(', ')}</span>
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => openEdit(plugin)} className="p-1.5 text-gray-600 hover:text-gray-300 transition-colors" title="Edit">
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => handleToggle(plugin)} className="p-1.5 text-gray-600 hover:text-gray-300 transition-colors" title={plugin.enabled ? 'Disable' : 'Enable'}>
              {plugin.enabled ? <PowerOff className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
            </button>
            <button onClick={() => handleRemove(plugin.id)} className="p-1.5 text-gray-600 hover:text-red-400 transition-colors" title="Remove">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}

      {/* Plugin form */}
      {showForm && (
        <div className="p-4 bg-white/[0.03] rounded-lg border border-accent/20 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-white">{editingId ? 'Edit Plugin' : 'Create Plugin'}</h4>
            <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-gray-300"><X className="w-4 h-4" /></button>
          </div>

          {error && <p className="text-xs text-red-400 bg-red-500/10 px-3 py-1.5 rounded">{error}</p>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-gray-500 mb-1 block">Name *</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/40" placeholder="My Custom Agent" />
            </div>
            <div>
              <label className="text-[11px] text-gray-500 mb-1 block">Agent Type *</label>
              <input value={form.agentType} onChange={(e) => setForm({ ...form, agentType: e.target.value })}
                className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/40" placeholder="my-agent" disabled={!!editingId} />
            </div>
            <div>
              <label className="text-[11px] text-gray-500 mb-1 block">Version</label>
              <input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })}
                className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/40" placeholder="1.0.0" />
            </div>
            <div>
              <label className="text-[11px] text-gray-500 mb-1 block">Icon (emoji)</label>
              <input value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })}
                className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/40" placeholder="🔌" />
            </div>
          </div>

          <div>
            <label className="text-[11px] text-gray-500 mb-1 block">Description *</label>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/40" placeholder="What this agent does" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-gray-500 mb-1 block">Author</label>
              <input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })}
                className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/40" placeholder="Your name" />
            </div>
            <div>
              <label className="text-[11px] text-gray-500 mb-1 block">Capabilities * (comma-separated)</label>
              <input value={form.capabilities} onChange={(e) => setForm({ ...form, capabilities: e.target.value })}
                className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/40" placeholder="summarization, translation" />
            </div>
          </div>

          <div>
            <label className="text-[11px] text-gray-500 mb-1 block">System Prompt *</label>
            <textarea value={form.systemPrompt} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
              rows={6}
              className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/40 resize-y font-mono"
              placeholder="You are a specialist agent that...&#10;&#10;Your task is to..." />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !form.name.trim() || !form.agentType.trim() || !form.systemPrompt.trim() || !form.description.trim() || !form.capabilities.trim()}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {editingId ? 'Update' : 'Install'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
