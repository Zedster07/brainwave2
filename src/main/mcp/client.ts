/**
 * MCP Client — Connects to a single MCP server, discovers tools, calls them
 *
 * Uses the official @modelcontextprotocol/sdk.
 * Supports stdio, SSE, and streamable-http transports.
 * Includes auto-reconnect with exponential backoff.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig, McpTool, McpToolCallResult, McpServerStatus } from './types'

/** Max reconnect attempts before giving up */
const MAX_RECONNECT_ATTEMPTS = 5
/** Base delay for exponential backoff (ms) */
const RECONNECT_BASE_DELAY = 1000

export class McpClient {
  readonly config: McpServerConfig
  private client: Client | null = null
  private transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | null = null
  private tools: McpTool[] = []
  private _status: McpServerStatus
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(config: McpServerConfig) {
    this.config = config
    this._status = {
      id: config.id,
      name: config.name,
      state: 'disconnected',
      toolCount: 0,
    }
  }

  get status(): McpServerStatus {
    return { ...this._status }
  }

  get discoveredTools(): McpTool[] {
    return [...this.tools]
  }

  /** Connect to the MCP server */
  async connect(): Promise<void> {
    if (this.client) {
      await this.disconnect()
    }

    this.disposed = false
    this._status = { ...this._status, state: 'connecting', error: undefined, reconnectAttempts: 0 }

    try {
      this.transport = this.createTransport()

      // Create & connect client
      this.client = new Client(
        { name: 'brainwave2', version: '1.0.0' },
        { capabilities: {} }
      )

      // Listen for close events to trigger reconnection
      this.client.onclose = () => {
        if (!this.disposed) {
          console.warn(`[MCP] Connection to "${this.config.name}" closed unexpectedly`)
          this.scheduleReconnect()
        }
      }

      await this.client.connect(this.transport)

      // Listen for tool list changes
      this.client.setNotificationHandler(
        { method: 'notifications/tools/list_changed' },
        async () => {
          console.log(`[MCP] Tool list changed for "${this.config.name}", refreshing...`)
          await this.refreshTools()
        }
      )

      // Discover tools
      await this.refreshTools()

      this.reconnectAttempts = 0
      this._status = {
        ...this._status,
        state: 'connected',
        connectedAt: Date.now(),
        toolCount: this.tools.length,
        reconnectAttempts: 0,
      }

      console.log(
        `[MCP] Connected to "${this.config.name}" — ${this.tools.length} tool(s) available`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this._status = {
        ...this._status,
        state: 'error',
        error: message,
        toolCount: 0,
      }
      console.error(`[MCP] Failed to connect to "${this.config.name}":`, message)
      throw err
    }
  }

  /** Disconnect from the MCP server */
  async disconnect(): Promise<void> {
    this.disposed = true
    this.cancelReconnect()

    try {
      if (this.client) {
        await this.client.close()
      }
    } catch {
      // Ignore disconnect errors
    } finally {
      this.client = null
      this.transport = null
      this.tools = []
      this._status = {
        ...this._status,
        state: 'disconnected',
        toolCount: 0,
        connectedAt: undefined,
        reconnectAttempts: 0,
      }
    }
  }

  /** Refresh the list of available tools from the server */
  async refreshTools(): Promise<McpTool[]> {
    if (!this.client) {
      throw new Error('Not connected')
    }

    const result = await this.client.listTools()

    this.tools = (result.tools ?? []).map((tool) => ({
      key: `${this.config.id}::${tool.name}`,
      serverId: this.config.id,
      serverName: this.config.name,
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
    }))

    this._status.toolCount = this.tools.length
    return this.tools
  }

  /** Call a tool on this MCP server */
  async callTool(
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<McpToolCallResult> {
    if (!this.client) {
      throw new Error(`Not connected to MCP server "${this.config.name}"`)
    }

    const start = Date.now()

    try {
      const result = await this.client.callTool({
        name: toolName,
        arguments: args,
      })

      const content = Array.isArray(result.content)
        ? result.content
            .map((c) => {
              if (c.type === 'text') return c.text
              if (c.type === 'image') return `[image: ${(c as { mimeType?: string }).mimeType ?? 'unknown'}]`
              return `[${c.type}]`
            })
            .join('\n')
        : String(result.content)

      return {
        toolKey: `${this.config.id}::${toolName}`,
        success: !result.isError,
        content,
        isError: !!result.isError,
        duration: Date.now() - start,
      }
    } catch (err) {
      return {
        toolKey: `${this.config.id}::${toolName}`,
        success: false,
        content: err instanceof Error ? err.message : String(err),
        isError: true,
        duration: Date.now() - start,
      }
    }
  }

  // ─── Transport Creation ───────────────────────────────────

  private createTransport(): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
    switch (this.config.transport) {
      case 'stdio': {
        if (!this.config.command) {
          throw new Error('stdio transport requires a command')
        }
        return new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: {
            ...process.env,
            ...this.config.env,
          } as Record<string, string>,
        })
      }

      case 'sse': {
        if (!this.config.url) {
          throw new Error('SSE transport requires a URL')
        }
        const sseUrl = new URL(this.config.url)
        // SSEClientTransport constructor: new SSEClientTransport(url, opts?)
        return new SSEClientTransport(sseUrl, {
          requestInit: this.config.headers
            ? { headers: this.config.headers }
            : undefined,
        })
      }

      case 'streamable-http': {
        if (!this.config.url) {
          throw new Error('streamable-http transport requires a URL')
        }
        const httpUrl = new URL(this.config.url)
        return new StreamableHTTPClientTransport(httpUrl, {
          requestInit: this.config.headers
            ? { headers: this.config.headers }
            : undefined,
        })
      }

      default:
        throw new Error(`Unsupported transport: ${this.config.transport}`)
    }
  }

  // ─── Reconnection Logic ───────────────────────────────────

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`[MCP] Max reconnect attempts reached for "${this.config.name}"`)
        this._status = {
          ...this._status,
          state: 'error',
          error: `Connection lost after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`,
        }
      }
      return
    }

    this.reconnectAttempts++
    const delay = RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts - 1)

    console.log(
      `[MCP] Reconnecting to "${this.config.name}" in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
    )

    this._status = {
      ...this._status,
      state: 'reconnecting',
      reconnectAttempts: this.reconnectAttempts,
    }

    this.reconnectTimer = setTimeout(async () => {
      try {
        // Clean up old client without triggering disposed flag
        try {
          if (this.client) await this.client.close()
        } catch { /* ignore */ }
        this.client = null
        this.transport = null
        this.tools = []

        await this.connect()
      } catch (err) {
        console.warn(
          `[MCP] Reconnect attempt ${this.reconnectAttempts} failed for "${this.config.name}":`,
          err instanceof Error ? err.message : err
        )
        this.scheduleReconnect()
      }
    }, delay)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
