/**
 * MCP Registry — Manages all MCP server connections and provides
 *               a unified tool catalog across all connected servers.
 *
 * Features:
 * - SQLite + JSON config file support (global + project-level)
 * - Zod-validated configs
 * - File watching for auto-reload on config changes
 * - Per-tool auto-approve integration
 * - Reference-counted singleton via McpServerManager
 */
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, watch, type FSWatcher } from 'fs'
import path from 'path'
import { app } from 'electron'
import { getDatabase } from '../db/database'
import { McpClient } from './client'
import { ServerConfigSchema } from './types'
import type {
  McpServerConfig,
  McpServerStatus,
  McpTool,
  McpToolCallResult,
  McpConfigSource,
} from './types'

const SETTINGS_KEY = 'mcp_servers'

/** Default global config file path: ~/.brainwave/mcp.json */
function getGlobalConfigPath(): string {
  return path.join(app.getPath('userData'), 'mcp.json')
}

// ─── JSON Config File Parsing ───────────────────────────────

/**
 * Strip JSONC comments (// and /* ... *​/) and trailing commas from raw text.
 */
function stripJsonComments(raw: string): string {
  // Remove single-line comments
  let cleaned = raw.replace(/\/\/.*$/gm, '')
  // Remove block comments
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '')
  // Remove trailing commas before } or ]
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1')
  return cleaned
}

/**
 * Parse an MCP config JSON file. Supports:
 * - { "servers": { "name": { ... } } }  (flat object, VS Code style)
 * - { "mcpServers": { "name": { ... } } }  (Cline/Roo style)
 * - Raw array of McpServerConfig
 * Each entry is validated with Zod; invalid entries are skipped with a warning.
 */
function parseConfigFile(filePath: string, source: McpConfigSource): McpServerConfig[] {
  if (!existsSync(filePath)) return []

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const cleaned = stripJsonComments(raw)
    const parsed = JSON.parse(cleaned)

    // Determine the server map
    let serverMap: Record<string, unknown> | null = null
    if (parsed.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers)) {
      serverMap = parsed.servers as Record<string, unknown>
    } else if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
      serverMap = parsed.mcpServers as Record<string, unknown>
    }

    const configs: McpServerConfig[] = []

    if (serverMap) {
      for (const [name, entry] of Object.entries(serverMap)) {
        if (!entry || typeof entry !== 'object') continue
        const raw = { name, id: randomUUID(), autoConnect: true, enabled: true, ...entry } as Record<string, unknown>
        // Map "type" → "transport" if needed (VS Code style uses "type")
        if (raw.type && !raw.transport) {
          raw.transport = raw.type === 'http' ? 'streamable-http' : raw.type
          delete raw.type
        }
        const result = ServerConfigSchema.safeParse(raw)
        if (result.success) {
          const config = result.data as unknown as McpServerConfig
          config.id = config.id ?? randomUUID()
          config.configSource = source
          configs.push(config)
        } else {
          console.warn(`[MCP] Invalid config for "${name}" in ${filePath}:`, result.error.issues.map(i => i.message).join(', '))
        }
      }
    } else if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const result = ServerConfigSchema.safeParse(entry)
        if (result.success) {
          const config = result.data as unknown as McpServerConfig
          config.id = config.id ?? randomUUID()
          config.configSource = source
          configs.push(config)
        }
      }
    }

    if (configs.length > 0) {
      console.log(`[MCP] Loaded ${configs.length} server(s) from ${filePath}`)
    }
    return configs
  } catch (err) {
    console.warn(`[MCP] Failed to parse config file ${filePath}:`, err instanceof Error ? err.message : err)
    return []
  }
}

// ─── Registry ───────────────────────────────────────────────

class McpRegistry {
  private clients = new Map<string, McpClient>()
  private fileWatchers: FSWatcher[] = []
  private projectDir: string | null = null
  /** Configs loaded from files (merged with SQLite at query time) */
  private fileConfigs: McpServerConfig[] = []

  /** Load saved configs and auto-connect all enabled servers */
  async initialize(): Promise<void> {
    // Load file-based configs
    this.loadFileConfigs()

    // Start watching config files
    this.startFileWatching()

    const configs = this.getMergedConfigs()
    const toConnect = configs.filter((c) => c.enabled)

    if (toConnect.length > 0) {
      console.log(`[MCP] Auto-connecting ${toConnect.length} enabled server(s)...`)
    }

    // Connect in parallel for faster startup
    let connected = 0
    await Promise.allSettled(
      toConnect.map(async (config) => {
        try {
          await this.connectWithConfig(config)
          connected++
          console.log(`[MCP] Connected: "${config.name}"`)
        } catch (err) {
          console.warn(`[MCP] Auto-connect failed for "${config.name}":`, err instanceof Error ? err.message : err)
        }
      })
    )

    console.log(`[MCP] Startup complete: ${connected}/${toConnect.length} servers connected`)
  }

  /** Set the active project directory (enables project-level MCP config) */
  setProjectDir(dir: string | null): void {
    const changed = this.projectDir !== dir
    this.projectDir = dir
    if (changed) {
      this.loadFileConfigs()
      this.restartFileWatching()
    }
  }

  // ─── Config Management ────────────────────────────────────

  /** Get all saved server configs (SQLite + file-based, merged) */
  getConfigs(): McpServerConfig[] {
    return this.getMergedConfigs()
  }

  /** Add a new MCP server config (persisted to SQLite) */
  addServer(config: Omit<McpServerConfig, 'id'>): McpServerConfig {
    // Validate with Zod
    const raw = { ...config, id: randomUUID() }
    const result = ServerConfigSchema.safeParse(raw)
    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      throw new Error(`Invalid MCP server config: ${issues}`)
    }

    const full: McpServerConfig = { ...(result.data as unknown as McpServerConfig), id: raw.id, configSource: 'sqlite' }
    const configs = this.loadSqliteConfigs()
    configs.push(full)
    this.saveSqliteConfigs(configs)
    return full
  }

  /** Update an existing server config (SQLite only — file configs are read-only) */
  updateServer(id: string, updates: Partial<McpServerConfig>): McpServerConfig | null {
    const configs = this.loadSqliteConfigs()
    const idx = configs.findIndex((c) => c.id === id)
    if (idx === -1) return null

    const merged = { ...configs[idx], ...updates, id } // preserve id
    // Validate merged config
    const result = ServerConfigSchema.safeParse(merged)
    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      throw new Error(`Invalid MCP server config: ${issues}`)
    }

    configs[idx] = { ...(result.data as unknown as McpServerConfig), id, configSource: 'sqlite' }
    this.saveSqliteConfigs(configs)
    return configs[idx]
  }

  /** Remove a server config and disconnect if active (SQLite only) */
  async removeServer(id: string): Promise<boolean> {
    await this.disconnect(id)

    const configs = this.loadSqliteConfigs()
    const filtered = configs.filter((c) => c.id !== id)
    if (filtered.length === configs.length) return false

    this.saveSqliteConfigs(filtered)
    return true
  }

  // ─── Connection Management ────────────────────────────────

  /** Connect to a specific server by ID */
  async connect(serverId: string): Promise<void> {
    const configs = this.getMergedConfigs()
    const config = configs.find((c) => c.id === serverId)
    if (!config) throw new Error(`MCP server not found: ${serverId}`)
    await this.connectWithConfig(config)
  }

  /** Connect using a full config object */
  private async connectWithConfig(config: McpServerConfig): Promise<void> {
    const client = new McpClient(config)
    // Store client first so error state is visible in getStatuses()
    this.clients.set(config.id, client)
    try {
      await client.connect()
    } catch (err) {
      // Client remains in map with state='error' so UI can show the failure
      throw err
    }
  }

  /** Disconnect from a specific server */
  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId)
    if (client) {
      await client.disconnect()
      this.clients.delete(serverId)
    }
  }

  /** Disconnect all servers */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.clients.keys()).map((id) => this.disconnect(id))
    await Promise.allSettled(promises)
  }

  /** Reload all configs and reconnect changed/new servers */
  async reload(): Promise<{ connected: number; disconnected: number; errors: string[] }> {
    console.log('[MCP] Reloading configuration...')
    this.loadFileConfigs()

    const newConfigs = this.getMergedConfigs()
    const newIds = new Set(newConfigs.map(c => c.id))
    const errors: string[] = []
    let connected = 0
    let disconnected = 0

    // Disconnect servers that are no longer in config
    for (const [id] of this.clients) {
      if (!newIds.has(id)) {
        await this.disconnect(id)
        disconnected++
      }
    }

    // Connect new/enabled servers that aren't connected yet
    for (const config of newConfigs) {
      if (config.enabled && !this.clients.has(config.id)) {
        try {
          await this.connectWithConfig(config)
          connected++
        } catch (err) {
          errors.push(`${config.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    console.log(`[MCP] Reload complete: +${connected} -${disconnected} (${errors.length} errors)`)
    return { connected, disconnected, errors }
  }

  // ─── Tool Catalog ─────────────────────────────────────────

  /** Get all tools from all connected servers */
  getAllTools(): McpTool[] {
    const tools: McpTool[] = []
    for (const client of this.clients.values()) {
      tools.push(...client.discoveredTools)
    }
    return tools
  }

  /** Get a compact tool catalog string for injection into agent prompts */
  getToolCatalog(): string {
    const tools = this.getAllTools()
    if (tools.length === 0) return ''

    const lines = tools.map((t) => {
      const params = Object.keys(
        (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      ).join(', ')
      return `- ${t.key}: ${t.description}${params ? ` (params: ${params})` : ''}`
    })

    return `Available MCP Tools:\n${lines.join('\n')}`
  }

  /** Find a tool by its key (serverId::toolName) */
  findTool(toolKey: string): McpTool | undefined {
    return this.getAllTools().find((t) => t.key === toolKey)
  }

  /** Call a tool by its key */
  async callTool(
    toolKey: string,
    args: Record<string, unknown> = {}
  ): Promise<McpToolCallResult> {
    const [serverId, toolName] = toolKey.split('::')
    if (!serverId || !toolName) {
      throw new Error(`Invalid tool key format: "${toolKey}" — expected "serverId::toolName"`)
    }

    const client = this.clients.get(serverId)
    if (!client) {
      throw new Error(`MCP server "${serverId}" is not connected`)
    }

    return client.callTool(toolName, args)
  }

  // ─── Per-Tool Auto-Approve (10.6) ─────────────────────────

  /**
   * Check if a specific tool is in the server's autoApprove list.
   * @param toolKey — "serverId::toolName" format
   * @returns true if the tool should bypass the approval prompt
   */
  isToolAutoApproved(toolKey: string): boolean {
    const [serverId, toolName] = toolKey.split('::')
    if (!serverId || !toolName) return false

    // Check all config sources
    const configs = this.getMergedConfigs()
    const config = configs.find(c => c.id === serverId)
    if (!config?.autoApprove) return false

    return config.autoApprove.includes(toolName)
  }

  /**
   * Get the autoApprove list for a specific server.
   */
  getAutoApproveList(serverId: string): string[] {
    const configs = this.getMergedConfigs()
    const config = configs.find(c => c.id === serverId)
    return config?.autoApprove ?? []
  }

  // ─── Status ───────────────────────────────────────────────

  /** Get status for all known servers (connected + disconnected) */
  getStatuses(): McpServerStatus[] {
    const configs = this.getMergedConfigs()
    return configs.map((config) => {
      const client = this.clients.get(config.id)
      if (client) return client.status
      return {
        id: config.id,
        name: config.name,
        state: 'disconnected' as const,
        toolCount: 0,
      }
    })
  }

  // ─── Config Merging ───────────────────────────────────────

  /**
   * Merge configs from all sources: SQLite → global file → project file.
   * SQLite configs have highest priority (user-managed).
   * File configs are additive — only added if no SQLite config has the same name.
   */
  private getMergedConfigs(): McpServerConfig[] {
    const sqliteConfigs = this.loadSqliteConfigs()
    const sqliteNames = new Set(sqliteConfigs.map(c => c.name.toLowerCase()))

    // Add file configs that don't conflict with SQLite
    const merged = [...sqliteConfigs]
    for (const fc of this.fileConfigs) {
      if (!sqliteNames.has(fc.name.toLowerCase())) {
        merged.push(fc)
      }
    }

    return merged
  }

  // ─── File Config Loading ──────────────────────────────────

  private loadFileConfigs(): void {
    const configs: McpServerConfig[] = []

    // Global config file
    const globalPath = getGlobalConfigPath()
    configs.push(...parseConfigFile(globalPath, 'global-file'))

    // Project-level config file
    if (this.projectDir) {
      const projectPath = path.join(this.projectDir, '.brainwave', 'mcp.json')
      configs.push(...parseConfigFile(projectPath, 'project-file'))
    }

    this.fileConfigs = configs
  }

  // ─── File Watching (10.4) ─────────────────────────────────

  private startFileWatching(): void {
    // Watch global config
    const globalPath = getGlobalConfigPath()
    this.watchConfigFile(globalPath)

    // Watch project config
    if (this.projectDir) {
      const projectPath = path.join(this.projectDir, '.brainwave', 'mcp.json')
      this.watchConfigFile(projectPath)
    }
  }

  private watchConfigFile(filePath: string): void {
    if (!existsSync(filePath)) return

    try {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null
      const watcher = watch(filePath, () => {
        // Debounce rapid changes (editors often save multiple times)
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(async () => {
          console.log(`[MCP] Config file changed: ${filePath}`)
          try {
            await this.reload()
          } catch (err) {
            console.warn('[MCP] Reload after config change failed:', err instanceof Error ? err.message : err)
          }
        }, 500)
      })
      this.fileWatchers.push(watcher)
    } catch (err) {
      console.warn(`[MCP] Failed to watch ${filePath}:`, err instanceof Error ? err.message : err)
    }
  }

  private stopFileWatching(): void {
    for (const watcher of this.fileWatchers) {
      try { watcher.close() } catch { /* ignore */ }
    }
    this.fileWatchers = []
  }

  private restartFileWatching(): void {
    this.stopFileWatching()
    this.startFileWatching()
  }

  // ─── SQLite Persistence ───────────────────────────────────

  private loadSqliteConfigs(): McpServerConfig[] {
    try {
      const db = getDatabase()
      const row = db.get<{ value: string }>(
        `SELECT value FROM settings WHERE key = ?`,
        SETTINGS_KEY
      )
      if (!row) return []

      const parsed = JSON.parse(row.value)
      if (!Array.isArray(parsed)) return []

      // Validate each config, keeping valid ones
      return parsed.map((entry: unknown) => {
        const result = ServerConfigSchema.safeParse(entry)
        if (result.success) {
          const config = result.data as unknown as McpServerConfig
          config.configSource = 'sqlite'
          return config
        }
        // For backward compatibility: if Zod rejects it but it looks like a config, keep it
        if (entry && typeof entry === 'object' && 'id' in entry && 'name' in entry) {
          return { ...(entry as McpServerConfig), configSource: 'sqlite' as const }
        }
        return null
      }).filter((c): c is McpServerConfig => c !== null)
    } catch {
      return []
    }
  }

  private saveSqliteConfigs(configs: McpServerConfig[]): void {
    const db = getDatabase()
    // Strip configSource before persisting
    const clean = configs.map(({ configSource, ...rest }) => rest)
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      SETTINGS_KEY,
      JSON.stringify(clean)
    )
  }

  // ─── Cleanup ──────────────────────────────────────────────

  async dispose(): Promise<void> {
    this.stopFileWatching()
    await this.disconnectAll()
  }
}

// ─── McpServerManager — Singleton with Reference Counting (10.1) ───

export class McpServerManager {
  private static instance: McpRegistry | null = null
  private static refCount = 0

  /** Acquire a reference to the shared McpRegistry. Initializes on first call. */
  static async acquire(): Promise<McpRegistry> {
    if (!this.instance) {
      this.instance = new McpRegistry()
      await this.instance.initialize()
    }
    this.refCount++
    return this.instance
  }

  /** Release a reference. Disposes when refCount reaches 0. */
  static async release(): Promise<void> {
    this.refCount--
    if (this.refCount <= 0 && this.instance) {
      await this.instance.dispose()
      this.instance = null
      this.refCount = 0
    }
  }

  /** Get the instance without incrementing refCount (for IPC handlers etc.) */
  static peek(): McpRegistry | null {
    return this.instance
  }
}

// ─── Backward-Compatible Singleton ──────────────────────────
// getMcpRegistry() is used throughout the codebase — keep it working.

let instance: McpRegistry | null = null

export function getMcpRegistry(): McpRegistry {
  if (!instance) {
    instance = new McpRegistry()
  }
  return instance
}

/** Initialize the registry and store as the global singleton */
export async function initializeMcpRegistry(): Promise<McpRegistry> {
  const registry = getMcpRegistry()
  await registry.initialize()
  return registry
}
