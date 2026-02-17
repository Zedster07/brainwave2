/**
 * MCP Types — Configuration and internal types for MCP integration
 */
import { z } from 'zod'

// ─── Zod Config Schemas (10.2) ──────────────────────────────

export const StdioConfigSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  autoConnect: z.boolean().default(true),
  enabled: z.boolean().default(true),
  autoApprove: z.array(z.string()).optional(),
})

export const SseConfigSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  autoConnect: z.boolean().default(true),
  enabled: z.boolean().default(true),
  autoApprove: z.array(z.string()).optional(),
})

export const StreamableHttpConfigSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  transport: z.literal('streamable-http'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  autoConnect: z.boolean().default(true),
  enabled: z.boolean().default(true),
  autoApprove: z.array(z.string()).optional(),
})

export const ServerConfigSchema = z.discriminatedUnion('transport', [
  StdioConfigSchema,
  SseConfigSchema,
  StreamableHttpConfigSchema,
])

export type ValidatedServerConfig = z.infer<typeof ServerConfigSchema>

// ─── Type Definitions ───────────────────────────────────────

/** How a server is connected */
export type McpTransport = 'stdio' | 'sse' | 'streamable-http'

/** Where a config was loaded from */
export type McpConfigSource = 'sqlite' | 'global-file' | 'project-file' | 'bundled'

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
  /** For SSE / streamable-http: server URL */
  url?: string
  /** For SSE / streamable-http: HTTP headers (e.g. Authorization) */
  headers?: Record<string, string>
  /** Whether to auto-connect on app launch */
  autoConnect: boolean
  /** User-enabled flag */
  enabled: boolean
  /** Tools that are auto-approved (bypass approval prompt) */
  autoApprove?: string[]
  /** Where this config was loaded from */
  configSource?: McpConfigSource
}

/** Runtime state of a connected MCP server */
export interface McpServerStatus {
  id: string
  name: string
  state: 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting'
  error?: string
  toolCount: number
  connectedAt?: number
  /** Number of reconnection attempts so far */
  reconnectAttempts?: number
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
