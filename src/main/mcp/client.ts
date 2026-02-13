/**
 * MCP Client — Connects to a single MCP server, discovers tools, calls them
 *
 * Uses the official @modelcontextprotocol/sdk.
 * Supports stdio and SSE transports.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { McpServerConfig, McpTool, McpToolCallResult, McpServerStatus } from './types'

export class McpClient {
  readonly config: McpServerConfig
  private client: Client | null = null
  private transport: StdioClientTransport | SSEClientTransport | null = null
  private tools: McpTool[] = []
  private _status: McpServerStatus

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

    this._status = { ...this._status, state: 'connecting', error: undefined }

    try {
      // Create transport
      if (this.config.transport === 'stdio') {
        if (!this.config.command) {
          throw new Error('stdio transport requires a command')
        }
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: {
            ...process.env,
            ...this.config.env,
          } as Record<string, string>,
        })
      } else if (this.config.transport === 'sse') {
        if (!this.config.url) {
          throw new Error('SSE transport requires a URL')
        }
        this.transport = new SSEClientTransport(new URL(this.config.url))
      } else {
        throw new Error(`Unsupported transport: ${this.config.transport}`)
      }

      // Create & connect client
      this.client = new Client(
        { name: 'brainwave2', version: '1.0.0' },
        { capabilities: {} }
      )

      await this.client.connect(this.transport)

      // Discover tools
      await this.refreshTools()

      this._status = {
        ...this._status,
        state: 'connected',
        connectedAt: Date.now(),
        toolCount: this.tools.length,
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
}
