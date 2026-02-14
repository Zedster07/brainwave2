/**
 * MCP Registry — Manages all MCP server connections and provides
 *               a unified tool catalog across all connected servers.
 *
 * Persists server configs to SQLite settings table.
 * Agents query this to discover what tools are available.
 */
import { randomUUID } from 'crypto'
import { getDatabase } from '../db/database'
import { McpClient } from './client'
import type {
  McpServerConfig,
  McpServerStatus,
  McpTool,
  McpToolCallResult,
} from './types'

const SETTINGS_KEY = 'mcp_servers'

class McpRegistry {
  private clients = new Map<string, McpClient>()

  /** Load saved configs and auto-connect all enabled servers */
  async initialize(): Promise<void> {
    const configs = this.loadConfigs()
    const toConnect = configs.filter((c) => c.enabled)

    if (toConnect.length > 0) {
      console.log(`[MCP] Auto-connecting ${toConnect.length} enabled server(s)...`)
    }

    // Connect in parallel for faster startup
    const results = await Promise.allSettled(
      toConnect.map(async (config) => {
        try {
          await this.connect(config.id)
          console.log(`[MCP] ✓ Connected: "${config.name}"`)
        } catch (err) {
          console.warn(`[MCP] ✗ Auto-connect failed for "${config.name}":`, err instanceof Error ? err.message : err)
        }
      })
    )

    const connected = results.filter((r) => r.status === 'fulfilled').length
    console.log(`[MCP] Startup complete: ${connected}/${toConnect.length} servers connected`)
  }

  // ─── Config Management ────────────────────────────────────

  /** Get all saved server configs */
  getConfigs(): McpServerConfig[] {
    return this.loadConfigs()
  }

  /** Add a new MCP server config */
  addServer(config: Omit<McpServerConfig, 'id'>): McpServerConfig {
    const full: McpServerConfig = { ...config, id: randomUUID() }
    const configs = this.loadConfigs()
    configs.push(full)
    this.saveConfigs(configs)
    return full
  }

  /** Update an existing server config */
  updateServer(id: string, updates: Partial<McpServerConfig>): McpServerConfig | null {
    const configs = this.loadConfigs()
    const idx = configs.findIndex((c) => c.id === id)
    if (idx === -1) return null

    configs[idx] = { ...configs[idx], ...updates, id } // preserve id
    this.saveConfigs(configs)
    return configs[idx]
  }

  /** Remove a server config and disconnect if active */
  async removeServer(id: string): Promise<boolean> {
    await this.disconnect(id)

    const configs = this.loadConfigs()
    const filtered = configs.filter((c) => c.id !== id)
    if (filtered.length === configs.length) return false

    this.saveConfigs(filtered)
    return true
  }

  // ─── Connection Management ────────────────────────────────

  /** Connect to a specific server */
  async connect(serverId: string): Promise<void> {
    const configs = this.loadConfigs()
    const config = configs.find((c) => c.id === serverId)
    if (!config) throw new Error(`MCP server not found: ${serverId}`)

    // Create client & connect
    const client = new McpClient(config)
    await client.connect()
    this.clients.set(serverId, client)
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

  // ─── Status ───────────────────────────────────────────────

  /** Get status for all known servers (connected + disconnected) */
  getStatuses(): McpServerStatus[] {
    const configs = this.loadConfigs()
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

  // ─── Persistence ──────────────────────────────────────────

  private loadConfigs(): McpServerConfig[] {
    try {
      const db = getDatabase()
      const row = db.get<{ value: string }>(
        `SELECT value FROM settings WHERE key = ?`,
        SETTINGS_KEY
      )
      return row ? JSON.parse(row.value) : []
    } catch {
      return []
    }
  }

  private saveConfigs(configs: McpServerConfig[]): void {
    const db = getDatabase()
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      SETTINGS_KEY,
      JSON.stringify(configs)
    )
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: McpRegistry | null = null

export function getMcpRegistry(): McpRegistry {
  if (!instance) {
    instance = new McpRegistry()
  }
  return instance
}
