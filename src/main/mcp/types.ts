/**
 * MCP Types — Configuration and internal types for MCP integration
 */

/** How a server is connected */
export type McpTransport = 'stdio' | 'sse'

/** Persisted MCP server configuration */
export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransport
  /** For stdio: command to run (e.g. "npx -y @modelcontextprotocol/server-brave-search") */
  command?: string
  /** For stdio: command arguments */
  args?: string[]
  /** For stdio: environment variables */
  env?: Record<string, string>
  /** For SSE: server URL */
  url?: string
  /** Whether to auto-connect on app launch */
  autoConnect: boolean
  /** User-enabled flag */
  enabled: boolean
}

/** Runtime state of a connected MCP server */
export interface McpServerStatus {
  id: string
  name: string
  state: 'disconnected' | 'connecting' | 'connected' | 'error'
  error?: string
  toolCount: number
  connectedAt?: number
}

/** A discovered MCP tool (from a server's tools/list response) */
export interface McpTool {
  /** Unique key: serverId::toolName */
  key: string
  serverId: string
  serverName: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Result from calling an MCP tool */
export interface McpToolCallResult {
  toolKey: string
  success: boolean
  content: string
  isError: boolean
  duration: number
}
