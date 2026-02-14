import { useState, useEffect, useCallback, useMemo } from 'react'
import { Settings as SettingsIcon, Key, Cpu, Shield, Database, Save, Check, Loader2, Eye, EyeOff, Zap, Activity, Wallet, Download, Upload, Monitor, Wifi, WifiOff, RefreshCw, ArrowDownCircle, Plug, Plus, Trash2, Power, PowerOff, Pencil, X, Wrench, Terminal, FileText, FolderOpen, Link2, Unlink2, Globe, ArrowRightLeft, FilePlus2, FolderTree, RotateCcw, Sun } from 'lucide-react'
import { ModelSelector } from '../../components/ModelSelector'
import type { PluginInfoData, McpServerConfigInfo, McpServerStatusInfo } from '@shared/types'

type SettingsTab = 'general' | 'models' | 'rules' | 'storage' | 'plugins' | 'tools' | 'daily-pulse'

const TABS: { id: SettingsTab; label: string; icon: typeof Key }[] = [
  { id: 'general', label: 'General', icon: SettingsIcon },
  { id: 'models', label: 'AI Models', icon: Cpu },
  { id: 'daily-pulse', label: 'Daily Pulse', icon: Sun },
  { id: 'rules', label: 'Rules Engine', icon: Shield },
  { id: 'storage', label: 'Storage', icon: Database },
  { id: 'plugins', label: 'Plugins', icon: Plug },
  { id: 'tools', label: 'Tools', icon: Wrench },
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
        {activeTab === 'daily-pulse' && <DailyPulseSettings />}
        {activeTab === 'rules' && <RulesSettings />}
        {activeTab === 'storage' && <StorageSettings />}
        {activeTab === 'plugins' && <PluginSettings />}
        {activeTab === 'tools' && <ToolsSettings />}
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
  const [sttApiKey, setSttApiKey] = useSetting<string>('stt_api_key', '')
  const [sttProvider, setSttProvider] = useSetting<string>('stt_provider', 'groq')
  const [showOpenRouter, setShowOpenRouter] = useState(false)
  const [showReplicate, setShowReplicate] = useState(false)
  const [showSttKey, setShowSttKey] = useState(false)
  const [modelMode, setModelMode] = useState<string>('normal')
  const [agentConfigs, setAgentConfigs] = useState<Record<string, { provider: string; model: string }> | null>(null)
  const [modeLoading, setModeLoading] = useState(false)
  const [ollamaStatus, setOllamaStatus] = useState<'unknown' | 'checking' | 'online' | 'offline'>('unknown')
  const [ollamaModels, setOllamaModels] = useState<Array<{ name: string; size: number }>>([]) 
  const [openRouterModels, setOpenRouterModels] = useState<Array<{ id: string; name: string }>>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [presets, setPresets] = useState<Record<string, Record<string, { provider: string; model: string }>> | null>(null)

  // Load current mode, agent configs, presets, and OpenRouter models on mount
  useEffect(() => {
    window.brainwave.getModelMode().then(setModelMode).catch(console.error)
    window.brainwave.getModelConfigs().then(setAgentConfigs).catch(console.error)
    window.brainwave.getModelPresets().then(setPresets).catch(console.error)
    // Auto-check Ollama status
    checkOllamaStatus()
    // Load OpenRouter models
    setModelsLoading(true)
    window.brainwave.listOpenRouterModels()
      .then(setOpenRouterModels)
      .catch(console.error)
      .finally(() => setModelsLoading(false))
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

      {/* Current Agent Assignments (Editable) */}
      {agentConfigs && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-500">Agent → model assignments (click to change):</p>
            <button
              onClick={async () => {
                await window.brainwave.resetAllAgentModels()
                const configs = await window.brainwave.getModelConfigs()
                setAgentConfigs(configs)
              }}
              className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-amber-400 transition-colors"
              title="Reset all agents to preset defaults"
            >
              <RotateCcw className="w-3 h-3" />
              Reset all
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {Object.entries(agentConfigs).map(([agent, config]) => {
              const presetModel = presets?.[modelMode]?.[agent]?.model
              const isOverridden = presetModel ? config.model !== presetModel : false
              return (
                <div key={agent} className="flex items-center gap-2 bg-white/[0.03] rounded px-3 py-1.5 min-w-0">
                  <span className="text-[11px] text-gray-400 capitalize shrink-0 w-20">{agent}</span>
                  <ModelSelector
                    value={config.model}
                    presetDefault={presetModel}
                    isOverridden={isOverridden}
                    models={openRouterModels}
                    loading={modelsLoading}
                    onChange={async (modelId) => {
                      await window.brainwave.setAgentModel(agent, modelId)
                      const configs = await window.brainwave.getModelConfigs()
                      setAgentConfigs(configs)
                    }}
                    onReset={async () => {
                      await window.brainwave.resetAgentModel(agent)
                      const configs = await window.brainwave.getModelConfigs()
                      setAgentConfigs(configs)
                    }}
                  />
                </div>
              )
            })}
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

      {/* Speech-to-Text (Voice Input) Section */}
      <div className="border-t border-white/[0.04] pt-4 space-y-4">
        <div>
          <p className="text-sm text-white font-medium">Speech-to-Text (Voice Input)</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Transcribes voice recordings using Whisper. Get a free Groq key at{' '}
            <a href="https://console.groq.com" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">console.groq.com</a>
          </p>
        </div>

        <SettingRow label="STT Provider" description="Which Whisper API to use for transcription">
          <select
            value={sttProvider ?? 'groq'}
            onChange={(e) => setSttProvider(e.target.value)}
            className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:border-accent/40"
          >
            <option value="groq" className="bg-gray-800">Groq (Free, fast)</option>
            <option value="openai" className="bg-gray-800">OpenAI</option>
          </select>
        </SettingRow>

        <SettingRow label="STT API Key" description={sttProvider === 'groq' ? 'Groq API key — free tier available' : 'OpenAI API key'}>
          <div className="flex items-center gap-2">
            <input
              type={showSttKey ? 'text' : 'password'}
              value={sttApiKey ?? ''}
              onChange={(e) => setSttApiKey(e.target.value)}
              placeholder={sttProvider === 'groq' ? 'gsk_...' : 'sk-...'}
              className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-accent/40"
            />
            <button onClick={() => setShowSttKey(!showSttKey)} className="text-gray-500 hover:text-gray-300">
              {showSttKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
            {sttApiKey && <Check className="w-4 h-4 text-green-400" />}
          </div>
        </SettingRow>
      </div>
    </div>
  )
}

function RulesSettings() {
  const [safetyRules, setSafetyRules] = useState<Record<string, unknown> | null>(null)
  const [proposals, setProposals] = useState<Array<{ id: string; rule: string; confidence: number }>>([])
  const [loading, setLoading] = useState(true)
  const [newBlockedPath, setNewBlockedPath] = useState('')
  const [newBlockedCmd, setNewBlockedCmd] = useState('')
  const [newBlockedExt, setNewBlockedExt] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rules, props] = await Promise.all([
        window.brainwave.getSafetyRules(),
        window.brainwave.getRuleProposals(),
      ])
      setSafetyRules(rules as Record<string, unknown>)
      setProposals(props as Array<{ id: string; rule: string; confidence: number }>)
    } catch (err) {
      console.error('Failed to load rules:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const fsRules = safetyRules?.filesystem as { blocked_paths?: string[]; user_blocked_paths?: string[]; blocked_extensions?: string[] } | undefined
  const systemPaths = fsRules?.blocked_paths ?? []
  const userPaths = fsRules?.user_blocked_paths ?? []
  const blockedExts = fsRules?.blocked_extensions ?? []
  const shellRules = safetyRules?.shell as { allow_shell?: boolean; blocked_commands?: string[] } | undefined
  const networkRules = safetyRules?.network as { allow_outbound?: boolean } | undefined

  const addBlockedPath = async () => {
    if (!newBlockedPath.trim() || !safetyRules) return
    setSaving(true)
    try {
      const fs = safetyRules.filesystem as Record<string, unknown>
      const current = (fs.user_blocked_paths as string[]) ?? []
      const updated = { ...safetyRules, filesystem: { ...fs, user_blocked_paths: [...current, newBlockedPath.trim()] } }
      await window.brainwave.setSafetyRules(updated)
      setSafetyRules(updated)
      setNewBlockedPath('')
    } catch (err) {
      console.error('Failed to add blocked path:', err)
    } finally {
      setSaving(false)
    }
  }

  const removeBlockedPath = async (path: string) => {
    if (!safetyRules) return
    setSaving(true)
    try {
      const fs = safetyRules.filesystem as Record<string, unknown>
      const current = (fs.user_blocked_paths as string[]) ?? []
      const updated = { ...safetyRules, filesystem: { ...fs, user_blocked_paths: current.filter((p: string) => p !== path) } }
      await window.brainwave.setSafetyRules(updated)
      setSafetyRules(updated)
    } catch (err) {
      console.error('Failed to remove blocked path:', err)
    } finally {
      setSaving(false)
    }
  }

  // ── Blocked Commands ──
  const addBlockedCommand = async () => {
    if (!newBlockedCmd.trim() || !safetyRules) return
    setSaving(true)
    try {
      const sh = safetyRules.shell as Record<string, unknown>
      const current = (sh.blocked_commands as string[]) ?? []
      if (current.some((c: string) => c.toLowerCase() === newBlockedCmd.trim().toLowerCase())) {
        setNewBlockedCmd('')
        return
      }
      const updated = { ...safetyRules, shell: { ...sh, blocked_commands: [...current, newBlockedCmd.trim()] } }
      await window.brainwave.setSafetyRules(updated)
      setSafetyRules(updated)
      setNewBlockedCmd('')
    } catch (err) {
      console.error('Failed to add blocked command:', err)
    } finally {
      setSaving(false)
    }
  }

  const removeBlockedCommand = async (cmd: string) => {
    if (!safetyRules) return
    setSaving(true)
    try {
      const sh = safetyRules.shell as Record<string, unknown>
      const current = (sh.blocked_commands as string[]) ?? []
      const updated = { ...safetyRules, shell: { ...sh, blocked_commands: current.filter((c: string) => c !== cmd) } }
      await window.brainwave.setSafetyRules(updated)
      setSafetyRules(updated)
    } catch (err) {
      console.error('Failed to remove blocked command:', err)
    } finally {
      setSaving(false)
    }
  }

  // ── Blocked Extensions ──
  const addBlockedExtension = async () => {
    if (!newBlockedExt.trim() || !safetyRules) return
    setSaving(true)
    try {
      const fs = safetyRules.filesystem as Record<string, unknown>
      const current = (fs.blocked_extensions as string[]) ?? []
      const ext = newBlockedExt.trim().startsWith('.') ? newBlockedExt.trim() : `.${newBlockedExt.trim()}`
      if (current.some((e: string) => e.toLowerCase() === ext.toLowerCase())) {
        setNewBlockedExt('')
        return
      }
      const updated = { ...safetyRules, filesystem: { ...fs, blocked_extensions: [...current, ext.toLowerCase()] } }
      await window.brainwave.setSafetyRules(updated)
      setSafetyRules(updated)
      setNewBlockedExt('')
    } catch (err) {
      console.error('Failed to add blocked extension:', err)
    } finally {
      setSaving(false)
    }
  }

  const removeBlockedExtension = async (ext: string) => {
    if (!safetyRules) return
    setSaving(true)
    try {
      const fs = safetyRules.filesystem as Record<string, unknown>
      const current = (fs.blocked_extensions as string[]) ?? []
      const updated = { ...safetyRules, filesystem: { ...fs, blocked_extensions: current.filter((e: string) => e !== ext) } }
      await window.brainwave.setSafetyRules(updated)
      setSafetyRules(updated)
    } catch (err) {
      console.error('Failed to remove blocked extension:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-white font-medium">Safety Rules</p>
          <p className="text-xs text-gray-500 mt-0.5">Hard limits — filesystem, shell, network restrictions</p>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full ${safetyRules ? 'bg-green-500/10 text-green-400' : 'bg-gray-500/10 text-gray-400'}`}>
          {loading ? 'Loading...' : safetyRules ? 'Active' : 'Not loaded'}
        </span>
      </div>

      {/* Capabilities summary */}
      {safetyRules && (
        <div className="bg-white/[0.02] rounded-lg p-4 space-y-3 border border-white/[0.04]">
          <p className="text-xs text-white font-medium mb-2">AI Capabilities</p>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              <span className="text-gray-400">File Read / Write / Create</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              <span className="text-gray-400">File Delete / Move / Rename</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              <span className="text-gray-400">Directory Listing</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${shellRules?.allow_shell ? 'bg-green-400' : 'bg-red-400'}`} />
              <span className="text-gray-400">Shell / Command Execution</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${networkRules?.allow_outbound ? 'bg-green-400' : 'bg-red-400'}`} />
              <span className="text-gray-400">HTTP / Network Requests</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />
              <span className="text-gray-400">All gated by safety rules</span>
            </div>
          </div>
        </div>
      )}

      {/* Prohibited Directories */}
      <div className="border-t border-white/[0.04] pt-4">
        <p className="text-sm text-white font-medium mb-1">Prohibited Directories</p>
        <p className="text-[11px] text-gray-500 mb-3">The AI cannot read, write, or delete files in these directories.</p>

        {/* System-blocked (read-only display) */}
        <div className="mb-3">
          <p className="text-[10px] text-gray-600 uppercase tracking-wider mb-1.5">System Protected (cannot be removed)</p>
          <div className="flex flex-wrap gap-1.5">
            {systemPaths.map((p) => (
              <span key={p} className="text-[10px] px-2 py-0.5 rounded bg-red-500/5 text-red-400/60 border border-red-500/10">
                {p}
              </span>
            ))}
          </div>
        </div>

        {/* User-blocked (editable) */}
        <div className="mb-3">
          <p className="text-[10px] text-gray-600 uppercase tracking-wider mb-1.5">Your Blocked Paths</p>
          {userPaths.length === 0 ? (
            <p className="text-[11px] text-gray-600 italic">No custom blocked paths. Add directories you want to protect below.</p>
          ) : (
            <div className="space-y-1.5">
              {userPaths.map((p) => (
                <div key={p} className="flex items-center justify-between bg-white/[0.03] rounded px-3 py-1.5">
                  <span className="text-xs text-white font-mono">{p}</span>
                  <button
                    onClick={() => removeBlockedPath(p)}
                    disabled={saving}
                    className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Add new path */}
        <div className="flex gap-2">
          <input
            type="text"
            value={newBlockedPath}
            onChange={(e) => setNewBlockedPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addBlockedPath()}
            placeholder="e.g. D:\Work\** or C:\Users\Me\Documents\Private\**"
            className="flex-1 bg-white/[0.03] border border-white/[0.08] rounded px-3 py-1.5 text-xs text-white font-mono placeholder:text-gray-600 focus:outline-none focus:border-accent/40"
          />
          <button
            onClick={addBlockedPath}
            disabled={saving || !newBlockedPath.trim()}
            className="text-[11px] px-3 py-1.5 rounded bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 whitespace-nowrap"
          >
            Add Path
          </button>
        </div>
        <p className="text-[10px] text-gray-600 mt-1">Use ** for recursive matching (e.g. D:\Secret\** blocks all contents)</p>
      </div>

      {/* Blocked Shell Commands */}
      {safetyRules && (
        <div className="border-t border-white/[0.04] pt-4">
          <p className="text-sm text-white font-medium mb-1">Blocked Shell Commands</p>
          <p className="text-[11px] text-gray-500 mb-3">The AI cannot execute these commands or patterns.</p>

          {(shellRules?.blocked_commands ?? []).length === 0 ? (
            <p className="text-[11px] text-gray-600 italic mb-3">No blocked commands.</p>
          ) : (
            <div className="space-y-1.5 mb-3">
              {(shellRules?.blocked_commands ?? []).map((cmd) => (
                <div key={cmd} className="flex items-center justify-between bg-white/[0.03] rounded px-3 py-1.5">
                  <span className="text-xs text-white font-mono">{cmd}</span>
                  <button
                    onClick={() => removeBlockedCommand(cmd)}
                    disabled={saving}
                    className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              value={newBlockedCmd}
              onChange={(e) => setNewBlockedCmd(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addBlockedCommand()}
              placeholder="e.g. netstat, taskkill, cipher"
              className="flex-1 bg-white/[0.03] border border-white/[0.08] rounded px-3 py-1.5 text-xs text-white font-mono placeholder:text-gray-600 focus:outline-none focus:border-accent/40"
            />
            <button
              onClick={addBlockedCommand}
              disabled={saving || !newBlockedCmd.trim()}
              className="text-[11px] px-3 py-1.5 rounded bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 whitespace-nowrap"
            >
              Add Command
            </button>
          </div>
          <p className="text-[10px] text-gray-600 mt-1">Commands are matched as substrings (e.g. &quot;format&quot; also blocks &quot;format C:&quot;)</p>
        </div>
      )}

      {/* Blocked File Extensions */}
      {safetyRules && (
        <div className="border-t border-white/[0.04] pt-4">
          <p className="text-sm text-white font-medium mb-1">Blocked File Extensions</p>
          <p className="text-[11px] text-gray-500 mb-3">The AI cannot write or create files with these extensions.</p>

          {blockedExts.length === 0 ? (
            <p className="text-[11px] text-gray-600 italic mb-3">No blocked extensions.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {blockedExts.map((ext) => (
                <div key={ext} className="flex items-center gap-1.5 bg-white/[0.03] rounded px-2 py-1 border border-white/[0.06]">
                  <span className="text-[11px] text-white font-mono">{ext}</span>
                  <button
                    onClick={() => removeBlockedExtension(ext)}
                    disabled={saving}
                    className="text-gray-600 hover:text-red-400 transition-colors disabled:opacity-50"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              value={newBlockedExt}
              onChange={(e) => setNewBlockedExt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addBlockedExtension()}
              placeholder="e.g. .dll, .sys, .msi"
              className="flex-1 bg-white/[0.03] border border-white/[0.08] rounded px-3 py-1.5 text-xs text-white font-mono placeholder:text-gray-600 focus:outline-none focus:border-accent/40"
            />
            <button
              onClick={addBlockedExtension}
              disabled={saving || !newBlockedExt.trim()}
              className="text-[11px] px-3 py-1.5 rounded bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 whitespace-nowrap"
            >
              Add Extension
            </button>
          </div>
        </div>
      )}

      {/* Rule Proposals */}
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

// ─── Daily Pulse Settings ───

function DailyPulseSettings() {
  const [userName, setUserName] = useSetting<string>('user_name', '')
  const [city, setCity] = useSetting<string>('daily_pulse_city', 'Algiers')
  const [interests, setInterests] = useSetting<string>('daily_pulse_interests', 'technology, AI, software development')
  const [atlassianSite, setAtlassianSite] = useSetting<string>('daily_pulse_atlassian_site', '')

  // ── Atlassian MCP integration state ──
  const [atlassianStatus, setAtlassianStatus] = useState<'loading' | 'not-configured' | 'disconnected' | 'connecting' | 'connected' | 'error'>('loading')
  const [atlassianServerId, setAtlassianServerId] = useState<string | null>(null)
  const [atlassianToolCount, setAtlassianToolCount] = useState(0)
  const [atlassianError, setAtlassianError] = useState<string | null>(null)
  const [atlassianBusy, setAtlassianBusy] = useState(false)

  // Check if Atlassian MCP server is already configured
  const refreshAtlassianStatus = useCallback(async () => {
    try {
      const [servers, statuses] = await Promise.all([
        window.brainwave.mcpGetServers(),
        window.brainwave.mcpGetStatuses(),
      ])
      const atlSrv = servers.find(
        (s: McpServerConfigInfo) => s.name === 'Atlassian' || s.name === 'atlassian' ||
        (s.args?.some((a: string) => a.includes('mcp.atlassian.com')))
      )
      if (atlSrv) {
        setAtlassianServerId(atlSrv.id)
        const st = statuses.find((s: McpServerStatusInfo) => s.id === atlSrv.id)
        if (st?.state === 'connected') {
          setAtlassianStatus('connected')
          setAtlassianToolCount(st.toolCount ?? 0)
          setAtlassianError(null)
        } else if (st?.state === 'error') {
          setAtlassianStatus('error')
          setAtlassianError(st.error ?? 'Connection failed')
        } else if (st?.state === 'connecting') {
          setAtlassianStatus('connecting')
        } else {
          setAtlassianStatus('disconnected')
        }
      } else {
        setAtlassianServerId(null)
        setAtlassianStatus('not-configured')
      }
    } catch {
      setAtlassianStatus('not-configured')
    }
  }, [])

  useEffect(() => { refreshAtlassianStatus() }, [refreshAtlassianStatus])

  // Poll status every 3s when connecting
  useEffect(() => {
    if (atlassianStatus !== 'connecting') return
    const interval = setInterval(refreshAtlassianStatus, 3000)
    return () => clearInterval(interval)
  }, [atlassianStatus, refreshAtlassianStatus])

  const handleConnectAtlassian = async () => {
    setAtlassianBusy(true)
    setAtlassianError(null)
    try {
      if (atlassianServerId) {
        // Server exists but disconnected — just connect
        await window.brainwave.mcpConnect(atlassianServerId)
        setAtlassianStatus('connecting')
      } else {
        // Register new Atlassian MCP server config
        await window.brainwave.mcpAddServer({
          name: 'Atlassian',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/mcp'],
          autoConnect: true,
          enabled: true,
        })
        // Refresh to get the new server ID, then connect
        const servers = await window.brainwave.mcpGetServers()
        const atlSrv = servers.find((s: McpServerConfigInfo) => s.name === 'Atlassian')
        if (atlSrv) {
          setAtlassianServerId(atlSrv.id)
          await window.brainwave.mcpConnect(atlSrv.id)
          setAtlassianStatus('connecting')
        }
      }
    } catch (err) {
      setAtlassianError(err instanceof Error ? err.message : 'Failed to connect')
      setAtlassianStatus('error')
    } finally {
      setAtlassianBusy(false)
      setTimeout(refreshAtlassianStatus, 2000)
    }
  }

  const handleDisconnectAtlassian = async () => {
    if (!atlassianServerId) return
    setAtlassianBusy(true)
    try {
      await window.brainwave.mcpDisconnect(atlassianServerId)
      setAtlassianStatus('disconnected')
    } catch {
      // ignore
    } finally {
      setAtlassianBusy(false)
      refreshAtlassianStatus()
    }
  }

  const handleRemoveAtlassian = async () => {
    if (!atlassianServerId) return
    setAtlassianBusy(true)
    try {
      await window.brainwave.mcpDisconnect(atlassianServerId).catch(() => {})
      await window.brainwave.mcpRemoveServer(atlassianServerId)
      setAtlassianServerId(null)
      setAtlassianStatus('not-configured')
    } catch {
      // ignore
    } finally {
      setAtlassianBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-white mb-1">Daily Pulse Configuration</h3>
        <p className="text-xs text-gray-500">Customize your morning briefing dashboard.</p>
      </div>

      <SettingRow
        label="Your Name"
        description="Used in the greeting — e.g. 'Good morning, Dada'"
      >
        <input
          type="text"
          value={userName ?? ''}
          onChange={(e) => setUserName(e.target.value)}
          placeholder="Enter your name"
          className="w-48 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-accent/40"
        />
      </SettingRow>

      <SettingRow
        label="Weather City"
        description="City shown in the weather card"
      >
        <input
          type="text"
          value={city ?? 'Algiers'}
          onChange={(e) => setCity(e.target.value)}
          placeholder="e.g. Algiers"
          className="w-48 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-accent/40"
        />
      </SettingRow>

      <SettingRow
        label="News Interests"
        description="Comma-separated topics for the news section"
      >
        <input
          type="text"
          value={interests ?? ''}
          onChange={(e) => setInterests(e.target.value)}
          placeholder="e.g. AI, gaming, finance"
          className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-accent/40"
        />
      </SettingRow>

      {/* ── Atlassian Integration ── */}
      <div className="border-t border-white/[0.04] pt-4">
        <div className="flex items-center gap-2 mb-3">
          <Globe className="w-4 h-4 text-blue-400" />
          <h4 className="text-sm font-semibold text-white">Atlassian Integration</h4>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Connect your Atlassian Cloud account to enable Jira &amp; Confluence in the Daily Pulse.
          Uses OAuth 2.1 — a browser window will open for authorization.
        </p>

        <SettingRow
          label="Atlassian Site URL"
          description="Your Atlassian Cloud site (e.g. myteam.atlassian.net) — required for Jira queries"
        >
          <input
            type="text"
            value={atlassianSite ?? ''}
            onChange={(e) => setAtlassianSite(e.target.value)}
            placeholder="e.g. myteam.atlassian.net"
            className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-accent/40"
          />
        </SettingRow>

        <div className="p-3 bg-white/[0.02] rounded-lg border border-white/[0.06]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {/* Status indicator */}
              <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                atlassianStatus === 'connected' ? 'bg-green-400' :
                atlassianStatus === 'connecting' ? 'bg-yellow-400 animate-pulse' :
                atlassianStatus === 'error' ? 'bg-red-400' :
                'bg-gray-600'
              }`} />
              <div>
                <p className="text-sm font-medium text-white">Atlassian Cloud</p>
                <p className="text-[10px] text-gray-500 mt-0.5">
                  {atlassianStatus === 'loading' && 'Checking status…'}
                  {atlassianStatus === 'not-configured' && 'Not connected — click Connect to set up'}
                  {atlassianStatus === 'disconnected' && 'Server configured but disconnected'}
                  {atlassianStatus === 'connecting' && 'Connecting… check your browser for OAuth prompt'}
                  {atlassianStatus === 'connected' && `Connected — ${atlassianToolCount} tools available (Jira, Confluence, Compass)`}
                  {atlassianStatus === 'error' && (atlassianError || 'Connection failed')}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {atlassianBusy ? (
                <Loader2 className="w-4 h-4 text-accent animate-spin" />
              ) : atlassianStatus === 'connected' ? (
                <button
                  onClick={handleDisconnectAtlassian}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-green-400 hover:text-red-400 bg-white/[0.04] rounded-md hover:bg-white/[0.08] transition-all"
                  title="Disconnect"
                >
                  <Unlink2 className="w-3.5 h-3.5" /> Disconnect
                </button>
              ) : atlassianStatus === 'connecting' ? (
                <Loader2 className="w-4 h-4 text-yellow-400 animate-spin" />
              ) : (
                <button
                  onClick={handleConnectAtlassian}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded-md transition-all font-medium"
                >
                  <Link2 className="w-3.5 h-3.5" /> Connect Atlassian
                </button>
              )}
              {atlassianServerId && atlassianStatus !== 'connecting' && (
                <button
                  onClick={handleRemoveAtlassian}
                  className="p-1.5 text-gray-600 hover:text-red-400 transition-colors"
                  title="Remove Atlassian server"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        <p className="text-[10px] text-gray-600 mt-2">
          Powered by <span className="text-gray-400">mcp-remote</span> → <span className="text-gray-400">mcp.atlassian.com</span> (Atlassian Rovo MCP Server). Requires Node.js 18+.
        </p>
      </div>

      {/* ── Info notes ── */}
      <div className="border-t border-white/[0.04] pt-4">
        <p className="text-xs text-gray-500">
          <strong className="text-gray-400">Brave Search MCP</strong> is required for Weather and News sections.
          Connect it in the <span className="text-accent">Tools</span> tab.
        </p>
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

// ─── Tools Settings (Local Tools + MCP Servers) ───

const LOCAL_TOOLS = [
  { name: 'file_read', icon: FileText, desc: 'Read file contents' },
  { name: 'file_write', icon: FolderOpen, desc: 'Write/overwrite files' },
  { name: 'file_create', icon: FilePlus2, desc: 'Create new files' },
  { name: 'file_delete', icon: Trash2, desc: 'Delete files' },
  { name: 'file_move', icon: ArrowRightLeft, desc: 'Move/rename files' },
  { name: 'directory_list', icon: FolderTree, desc: 'List directory contents' },
  { name: 'shell_execute', icon: Terminal, desc: 'Execute shell commands' },
  { name: 'http_request', icon: Globe, desc: 'Make HTTP requests' },
]

interface McpFormState {
  name: string
  transport: 'stdio' | 'sse'
  command: string
  args: string
  url: string
  env: string
  autoConnect: boolean
}

const emptyMcpForm: McpFormState = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  env: '',
  autoConnect: true,
}

function ToolsSettings() {
  const [servers, setServers] = useState<McpServerConfigInfo[]>([])
  const [statuses, setStatuses] = useState<McpServerStatusInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<McpFormState>(emptyMcpForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)

  // ── Import JSON state ──
  const [showImport, setShowImport] = useState(false)
  const [importJson, setImportJson] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([
        window.brainwave.mcpGetServers(),
        window.brainwave.mcpGetStatuses(),
      ])
      setServers(s)
      setStatuses(st)
    } catch (err) {
      console.error('[ToolsSettings] Failed to load:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Poll statuses every 3s so we see servers come online after startup
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const st = await window.brainwave.mcpGetStatuses()
        setStatuses(st)
      } catch { /* ignore */ }
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  const getStatus = (id: string) => statuses.find((s) => s.id === id)

  const handleAdd = async () => {
    setError(null)
    setSaving(true)
    try {
      // Parse env vars from "KEY=VALUE" lines
      let env: Record<string, string> | undefined
      if (form.env.trim()) {
        env = {}
        for (const line of form.env.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          const eqIdx = trimmed.indexOf('=')
          if (eqIdx > 0) {
            env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
          }
        }
        if (Object.keys(env).length === 0) env = undefined
      }

      const config: Omit<McpServerConfigInfo, 'id'> = {
        name: form.name.trim(),
        transport: form.transport,
        command: form.transport === 'stdio' ? form.command.trim() : undefined,
        args: form.transport === 'stdio' && form.args.trim()
          ? form.args.split(',').map((a) => a.trim()).filter(Boolean)
          : undefined,
        url: form.transport === 'sse' ? form.url.trim() : undefined,
        env,
        autoConnect: form.autoConnect,
        enabled: true,
      }
      if (!config.name) throw new Error('Server name is required')
      if (form.transport === 'stdio' && !config.command) throw new Error('Command is required for stdio')
      if (form.transport === 'sse' && !config.url) throw new Error('URL is required for SSE')

      await window.brainwave.mcpAddServer(config)
      setShowForm(false)
      setForm(emptyMcpForm)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add server')
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (id: string) => {
    try {
      await window.brainwave.mcpDisconnect(id).catch(() => {})
      await window.brainwave.mcpRemoveServer(id)
      await refresh()
    } catch (err) {
      console.error('Failed to remove server:', err)
    }
  }

  const handleConnect = async (id: string) => {
    setConnecting(id)
    try {
      await window.brainwave.mcpConnect(id)
    } catch (err) {
      console.error('Failed to connect:', err)
    }
    await refresh()
    setConnecting(null)
  }

  const handleDisconnect = async (id: string) => {
    setConnecting(id)
    try {
      await window.brainwave.mcpDisconnect(id)
    } catch (err) {
      console.error('Failed to disconnect:', err)
    }
    await refresh()
    setConnecting(null)
  }

  // ── Import JSON handler ──
  const handleImportJson = async () => {
    if (!importJson.trim()) return
    setImportBusy(true)
    setImportResult(null)
    try {
      const result = await window.brainwave.mcpImportServers(importJson)
      setImportResult(result)
      if (result.imported > 0) {
        await refresh()
      }
    } catch (err) {
      setImportResult({ imported: 0, skipped: 0, errors: [err instanceof Error ? err.message : 'Import failed'] })
    } finally {
      setImportBusy(false)
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
  }

  return (
    <div className="space-y-6">
      {/* ── Local Built-in Tools ── */}
      <div>
        <h3 className="text-sm font-semibold text-white mb-1">Built-in Local Tools</h3>
        <p className="text-xs text-gray-500 mb-3">
          File and shell tools available to the Executor agent. Gated by{' '}
          <span className="text-accent">Safety Rules</span>.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {LOCAL_TOOLS.map((t) => {
            const Icon = t.icon
            return (
              <div key={t.name} className="flex items-center gap-2.5 p-2.5 bg-white/[0.02] rounded-lg border border-white/[0.06]">
                <Icon className="w-4 h-4 text-accent flex-shrink-0" />
                <div>
                  <p className="text-xs font-medium text-white">local::{t.name}</p>
                  <p className="text-[10px] text-gray-500">{t.desc}</p>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="border-t border-white/[0.06]" />

      {/* ── MCP Servers ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">MCP Servers</h3>
            <p className="text-xs text-gray-500 mt-0.5">Connect external tool servers via Model Context Protocol</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setImportJson(''); setImportResult(null); setShowImport(true) }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] text-gray-400 text-xs font-medium hover:bg-white/[0.08] hover:text-white transition-all"
            >
              <Download className="w-3.5 h-3.5" /> Import JSON
            </button>
            <button
              onClick={() => { setForm(emptyMcpForm); setError(null); setShowForm(true) }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/10 text-accent text-xs font-medium hover:bg-accent/20 transition-all"
            >
              <Plus className="w-3.5 h-3.5" /> Add Server
            </button>
          </div>
        </div>

        {/* Server list */}
        {servers.length === 0 && !showForm && (
          <div className="text-center py-6 text-gray-600 text-sm">
            No MCP servers configured. Add one to extend the AI&apos;s capabilities.
          </div>
        )}

        {servers.map((srv) => {
          const status = getStatus(srv.id)
          const isConnected = status?.state === 'connected'
          const isError = status?.state === 'error'
          const isBusy = connecting === srv.id

          return (
            <div key={srv.id} className="flex items-center gap-3 p-3 mb-2 bg-white/[0.02] rounded-lg border border-white/[0.06]">
              {/* Status dot */}
              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                isConnected ? 'bg-green-400' : isError ? 'bg-red-400' : 'bg-gray-600'
              }`} />

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-white truncate">{srv.name}</p>
                  <span className="text-[10px] text-gray-600 bg-white/[0.04] px-1.5 py-0.5 rounded">{srv.transport}</span>
                  {isConnected && status?.toolCount !== undefined && (
                    <span className="text-[10px] text-accent">{status.toolCount} tools</span>
                  )}
                </div>
                <p className="text-[10px] text-gray-500 truncate mt-0.5">
                  {srv.transport === 'stdio'
                    ? `${srv.command}${srv.args?.length ? ' ' + srv.args.join(' ') : ''}`
                    : srv.url}
                </p>
                {isError && status?.error && (
                  <p className="text-[10px] text-red-400 truncate mt-0.5">{status.error}</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1">
                {isBusy ? (
                  <Loader2 className="w-4 h-4 text-gray-500 animate-spin" />
                ) : isConnected ? (
                  <button
                    onClick={() => handleDisconnect(srv.id)}
                    className="p-1.5 text-green-400 hover:text-red-400 transition-colors"
                    title="Disconnect"
                  >
                    <Unlink2 className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    onClick={() => handleConnect(srv.id)}
                    className="p-1.5 text-gray-600 hover:text-green-400 transition-colors"
                    title="Connect"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={() => handleRemove(srv.id)}
                  className="p-1.5 text-gray-600 hover:text-red-400 transition-colors"
                  title="Remove"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )
        })}

        {/* Import JSON modal */}
        {showImport && (
          <div className="p-4 bg-white/[0.03] rounded-lg border border-accent/20 space-y-3 mt-2 mb-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-white flex items-center gap-2">
                <Download className="w-4 h-4 text-accent" /> Import MCP Servers from JSON
              </h4>
              <button onClick={() => setShowImport(false)} className="text-gray-500 hover:text-gray-300"><X className="w-4 h-4" /></button>
            </div>

            <p className="text-[11px] text-gray-500">
              Paste a VS Code MCP config JSON. Supports <code className="text-gray-400 bg-white/[0.04] px-1 rounded">{'{ "servers": { ... } }'}</code> and <code className="text-gray-400 bg-white/[0.04] px-1 rounded">{'{ "mcpServers": { ... } }'}</code> formats.
            </p>

            <textarea
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
              placeholder={`{
  "servers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    },
    "remote-api": {
      "type": "http",
      "url": "http://localhost:3001/sse"
    }
  }
}`}
              className="w-full h-48 bg-black/20 border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-gray-300 font-mono focus:outline-none focus:border-accent/40 resize-y"
              spellCheck={false}
            />

            {/* Results */}
            {importResult && (
              <div className={`text-xs px-3 py-2 rounded-lg ${
                importResult.errors.length > 0 && importResult.imported === 0
                  ? 'bg-red-500/10 text-red-400'
                  : importResult.imported > 0
                    ? 'bg-green-500/10 text-green-400'
                    : 'bg-yellow-500/10 text-yellow-400'
              }`}>
                <div className="flex items-center gap-3 mb-1">
                  {importResult.imported > 0 && <span className="flex items-center gap-1"><Check className="w-3 h-3" /> {importResult.imported} imported</span>}
                  {importResult.skipped > 0 && <span>{importResult.skipped} skipped</span>}
                </div>
                {importResult.errors.length > 0 && (
                  <ul className="space-y-0.5 mt-1">
                    {importResult.errors.map((e, i) => <li key={i} className="text-[10px] text-gray-400">{e}</li>)}
                  </ul>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowImport(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
              <button
                onClick={handleImportJson}
                disabled={importBusy || !importJson.trim()}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                {importBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                Import Servers
              </button>
            </div>
          </div>
        )}

        {/* Add server form */}
        {showForm && (
          <div className="p-4 bg-white/[0.03] rounded-lg border border-accent/20 space-y-3 mt-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-white">Add MCP Server</h4>
              <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-gray-300"><X className="w-4 h-4" /></button>
            </div>

            {error && <p className="text-xs text-red-400 bg-red-500/10 px-3 py-1.5 rounded">{error}</p>}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] text-gray-500 mb-1 block">Server Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/40" placeholder="e.g. filesystem" />
              </div>
              <div>
                <label className="text-[11px] text-gray-500 mb-1 block">Transport *</label>
                <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as 'stdio' | 'sse' })}
                  className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/40">
                  <option value="stdio">stdio (local process)</option>
                  <option value="sse">SSE (remote URL)</option>
                </select>
              </div>
            </div>

            {form.transport === 'stdio' ? (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-gray-500 mb-1 block">Command *</label>
                  <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })}
                    className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/40" placeholder="npx, node, python..." />
                </div>
                <div>
                  <label className="text-[11px] text-gray-500 mb-1 block">Arguments (comma-separated)</label>
                  <input value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })}
                    className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/40" placeholder="-y, @modelcontextprotocol/server-filesystem, /path" />
                </div>
              </div>
            ) : (
              <div>
                <label className="text-[11px] text-gray-500 mb-1 block">Server URL *</label>
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })}
                  className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/40" placeholder="http://localhost:3001/sse" />
              </div>
            )}

            <div>
              <label className="text-[11px] text-gray-500 mb-1 block">Environment Variables</label>
              <textarea
                value={form.env}
                onChange={(e) => setForm({ ...form, env: e.target.value })}
                rows={3}
                className="w-full bg-white/[0.03] border border-white/[0.08] rounded px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-accent/40 resize-y"
                placeholder={"TAVILY_API_KEY=tvly-xxx\nGITHUB_TOKEN=ghp-xxx\n# One KEY=VALUE per line"}
              />
              <p className="text-[10px] text-gray-600 mt-0.5">Passed to the server process. Lines starting with # are ignored.</p>
            </div>

            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input type="checkbox" checked={form.autoConnect} onChange={(e) => setForm({ ...form, autoConnect: e.target.checked })}
                className="rounded border-white/20 bg-white/[0.03] text-accent focus:ring-accent/30" />
              Auto-connect on startup
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
              <button
                onClick={handleAdd}
                disabled={saving || !form.name.trim()}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Add Server
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}