/**
 * Plugin Types — Manifest schema and runtime types for the plugin system
 */

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  author?: string
  agentType: string // custom agent type — must not collide with built-in types
  capabilities: string[]
  systemPrompt: string // the agent's system prompt template
  modelPreference?: {
    provider?: 'openrouter' | 'replicate' | 'ollama'
    model?: string
  }
  icon?: string // lucide icon name or emoji
  tags?: string[] // searchable tags
}

export interface PluginInfo extends PluginManifest {
  enabled: boolean
  installedAt: number
  updatedAt: number
}

/** Built-in agent types that plugins cannot override */
export const BUILT_IN_AGENT_TYPES = [
  'orchestrator',
  'planner',
  'researcher',
  'coder',
  'writer',
  'analyst',
  'critic',
  'reviewer',
  'reflection',
  'executor',
] as const

export type BuiltInAgentType = (typeof BUILT_IN_AGENT_TYPES)[number]

export function isBuiltInAgentType(type: string): type is BuiltInAgentType {
  return BUILT_IN_AGENT_TYPES.includes(type as BuiltInAgentType)
}
