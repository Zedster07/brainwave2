/**
 * Plugin Registry — Manages installed plugins and their lifecycle
 *
 * Plugins are stored as JSON manifests in SQLite. Each plugin defines a
 * custom agent type that gets registered in the agent pool at startup
 * or when installed. Plugins can be enabled/disabled without removal.
 */
import { randomUUID } from 'crypto'
import { getDatabase } from '../db/database'
import { getAgentPool } from '../agents/agent-pool'
import { PluginAgent } from './plugin-agent'
import { isBuiltInAgentType, type PluginInfo, type PluginManifest } from './types'

class PluginRegistry {
  private plugins = new Map<string, PluginInfo>()
  private agents = new Map<string, PluginAgent>()

  /** Load all plugins from SQLite and register enabled ones */
  initialize(): void {
    const db = getDatabase()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('plugins') as
      | { value: string }
      | undefined

    if (row) {
      try {
        const stored: PluginInfo[] = JSON.parse(row.value)
        for (const plugin of stored) {
          this.plugins.set(plugin.id, plugin)
          if (plugin.enabled) {
            this.registerAgent(plugin)
          }
        }
        console.log(
          `[PluginRegistry] Loaded ${stored.length} plugins (${stored.filter((p) => p.enabled).length} enabled)`
        )
      } catch (err) {
        console.error('[PluginRegistry] Failed to parse stored plugins:', err)
      }
    } else {
      console.log('[PluginRegistry] No plugins installed')
    }
  }

  /** Install a new plugin from a manifest */
  install(manifest: Omit<PluginManifest, 'id'>): PluginInfo {
    // Validate
    this.validateManifest(manifest)

    // Check for duplicate agentType
    for (const existing of this.plugins.values()) {
      if (existing.agentType === manifest.agentType) {
        throw new Error(`Agent type "${manifest.agentType}" is already registered by plugin "${existing.name}"`)
      }
    }

    const plugin: PluginInfo = {
      ...manifest,
      id: randomUUID(),
      enabled: true,
      installedAt: Date.now(),
      updatedAt: Date.now(),
    }

    this.plugins.set(plugin.id, plugin)
    this.registerAgent(plugin)
    this.persist()

    console.log(`[PluginRegistry] Installed plugin: ${plugin.name} (${plugin.agentType})`)
    return plugin
  }

  /** Update an existing plugin's manifest */
  update(id: string, updates: Partial<Omit<PluginManifest, 'id'>>): PluginInfo | null {
    const plugin = this.plugins.get(id)
    if (!plugin) return null

    // If agentType is changing, validate it
    if (updates.agentType && updates.agentType !== plugin.agentType) {
      if (isBuiltInAgentType(updates.agentType)) {
        throw new Error(`Cannot use built-in agent type "${updates.agentType}"`)
      }
      for (const existing of this.plugins.values()) {
        if (existing.id !== id && existing.agentType === updates.agentType) {
          throw new Error(`Agent type "${updates.agentType}" is already in use`)
        }
      }
    }

    // Unregister old agent if type changed or prompt changed
    this.unregisterAgent(id)

    const updated: PluginInfo = {
      ...plugin,
      ...updates,
      id: plugin.id, // prevent id override
      updatedAt: Date.now(),
    }

    this.plugins.set(id, updated)
    if (updated.enabled) {
      this.registerAgent(updated)
    }
    this.persist()

    console.log(`[PluginRegistry] Updated plugin: ${updated.name}`)
    return updated
  }

  /** Remove a plugin entirely */
  remove(id: string): boolean {
    const plugin = this.plugins.get(id)
    if (!plugin) return false

    this.unregisterAgent(id)
    this.plugins.delete(id)
    this.persist()

    console.log(`[PluginRegistry] Removed plugin: ${plugin.name}`)
    return true
  }

  /** Enable a disabled plugin */
  enable(id: string): PluginInfo | null {
    const plugin = this.plugins.get(id)
    if (!plugin) return null

    plugin.enabled = true
    plugin.updatedAt = Date.now()
    this.registerAgent(plugin)
    this.persist()

    console.log(`[PluginRegistry] Enabled plugin: ${plugin.name}`)
    return plugin
  }

  /** Disable an enabled plugin (keeps it installed) */
  disable(id: string): PluginInfo | null {
    const plugin = this.plugins.get(id)
    if (!plugin) return null

    plugin.enabled = false
    plugin.updatedAt = Date.now()
    this.unregisterAgent(id)
    this.persist()

    console.log(`[PluginRegistry] Disabled plugin: ${plugin.name}`)
    return plugin
  }

  /** Get all installed plugins */
  getPlugins(): PluginInfo[] {
    return [...this.plugins.values()]
  }

  /** Get a single plugin by ID */
  getPlugin(id: string): PluginInfo | null {
    return this.plugins.get(id) ?? null
  }

  /** Get a plugin agent instance */
  getAgent(id: string): PluginAgent | undefined {
    return this.agents.get(id)
  }

  // ─── Internal ─────────────────────────────────────────────

  private validateManifest(manifest: Partial<PluginManifest>): void {
    if (!manifest.name?.trim()) throw new Error('Plugin name is required')
    if (!manifest.agentType?.trim()) throw new Error('Agent type is required')
    if (!manifest.systemPrompt?.trim()) throw new Error('System prompt is required')
    if (!manifest.description?.trim()) throw new Error('Description is required')
    if (!manifest.version?.trim()) throw new Error('Version is required')

    // Agent type validation
    if (isBuiltInAgentType(manifest.agentType)) {
      throw new Error(`Cannot use built-in agent type "${manifest.agentType}"`)
    }

    // Sanitize agent type — lowercase, alphanumeric + hyphens only
    if (!/^[a-z][a-z0-9-]*$/.test(manifest.agentType)) {
      throw new Error('Agent type must be lowercase alphanumeric with hyphens, starting with a letter')
    }

    if (!manifest.capabilities?.length) {
      throw new Error('At least one capability is required')
    }
  }

  private registerAgent(plugin: PluginInfo): void {
    try {
      const agent = new PluginAgent(plugin)
      this.agents.set(plugin.id, agent)

      // Register in the global agent pool
      const pool = getAgentPool()
      pool.registry.register(agent)

      console.log(`[PluginRegistry] Registered agent: ${plugin.agentType}`)
    } catch (err) {
      console.error(`[PluginRegistry] Failed to register agent for plugin ${plugin.name}:`, err)
    }
  }

  private unregisterAgent(id: string): void {
    const agent = this.agents.get(id)
    if (agent) {
      // Note: AgentRegistry doesn't have an unregister method,
      // but since it's a Map, the agent will simply be replaced if re-registered
      // with a new type, or ignored if disabled.
      this.agents.delete(id)
    }
  }

  private persist(): void {
    try {
      const db = getDatabase()
      const data = JSON.stringify([...this.plugins.values()])
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('plugins', data)
    } catch (err) {
      console.error('[PluginRegistry] Failed to persist plugins:', err)
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: PluginRegistry | null = null

export function getPluginRegistry(): PluginRegistry {
  if (!instance) {
    instance = new PluginRegistry()
  }
  return instance
}
