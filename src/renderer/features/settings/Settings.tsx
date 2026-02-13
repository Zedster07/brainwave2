import { useState } from 'react'
import { Settings as SettingsIcon, Key, Cpu, Shield, Database } from 'lucide-react'

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
  return (
    <div className="space-y-6">
      <SettingRow
        label="UI Transparency Level"
        description="How much detail to show when agents are working"
      >
        <select className="bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:border-accent/40">
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
          defaultValue={3}
          min={1}
          max={8}
          className="w-20 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white text-center focus:outline-none focus:border-accent/40"
        />
      </SettingRow>
    </div>
  )
}

function ModelSettings() {
  return (
    <div className="space-y-6">
      <SettingRow label="OpenRouter API Key" description="Required for LLM access">
        <input
          type="password"
          placeholder="sk-or-..."
          className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-accent/40"
        />
      </SettingRow>

      <SettingRow label="Default Chat Model" description="Used by most agents">
        <input
          type="text"
          defaultValue="anthropic/claude-sonnet-4-20250514"
          className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:border-accent/40"
        />
      </SettingRow>

      <SettingRow label="Replicate API Key" description="For specialist models (optional)">
        <input
          type="password"
          placeholder="r8_..."
          className="w-64 bg-white/[0.05] border border-white/[0.08] rounded-md px-3 py-1.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-accent/40"
        />
      </SettingRow>
    </div>
  )
}

function RulesSettings() {
  return (
    <div className="text-center py-8">
      <Shield className="w-8 h-8 text-gray-600 mx-auto mb-3" />
      <p className="text-sm text-gray-500">
        Rules engine configuration will be available here.
      </p>
      <p className="text-xs text-gray-600 mt-1">
        Hard rules (safety) and soft rules (behavior) managed via YAML configs.
      </p>
    </div>
  )
}

function StorageSettings() {
  return (
    <div className="space-y-6">
      <SettingRow label="Database Location" description="SQLite database file path">
        <span className="text-sm text-gray-400 font-mono">~/.brainwave2/brain.db</span>
      </SettingRow>

      <SettingRow label="Database Size" description="Current memory footprint">
        <span className="text-sm text-gray-400">0 KB</span>
      </SettingRow>
    </div>
  )
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
