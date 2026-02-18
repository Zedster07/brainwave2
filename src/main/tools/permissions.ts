/**
 * Tool Permission System
 *
 * Defines per-agent-type tool access levels. Every agent can SEE all tools
 * in the catalog (for awareness), but only EXECUTE tools matching their
 * permission tier. The executor agent gets full access; other agents get
 * curated subsets appropriate to their role.
 *
 * Permission Tiers:
 *   - full:      All tools, no restrictions (executor only)
 *   - readWrite: Read/write filesystem + web + MCP tools, no dangerous shell
 *   - read:      Read-only filesystem + web search + safe MCP tools
 *   - none:      No tool access (pure reasoning agents)
 */
import type { AgentType } from '../agents/event-bus'
import type { ModeConfig } from '../modes'
import { resolveToolGroups, modeAllowsMcp } from '../modes'

// ─── Permission Types ───────────────────────────────────────

export type ToolPermissionTier = 'full' | 'readWrite' | 'read' | 'none'

export interface ToolPermissionConfig {
  tier: ToolPermissionTier
  /** Explicit allow-list of local tool names (overrides tier for fine-grained control) */
  allowedLocalTools?: string[]
  /** Explicit block-list of local tool names */
  blockedLocalTools?: string[]
  /** Max tool calls per task (prevents runaway loops) */
  maxSteps?: number
  /** Overall timeout in ms */
  timeoutMs?: number
}

// ─── Per-Agent Permission Map ───────────────────────────────

const AGENT_PERMISSIONS: Record<string, ToolPermissionConfig> = {
  // Full access — the power user
  executor: {
    tier: 'full',
    timeoutMs: 10 * 60 * 1000, // 10 min — browser automation can be long
  },

  // Read + web search — can look things up, can't modify
  researcher: {
    tier: 'read',
    allowedLocalTools: ['web_search', 'webpage_fetch', 'file_read', 'directory_list', 'http_request', 'search_files', 'list_code_definition_names', 'ask_followup_question', 'grep_search', 'git_info', 'discover_tools'],
    timeoutMs: 8 * 60 * 1000, // 8 min — web research chains can be lengthy
  },

  // Read filesystem + write code — can read context, write files
  coder: {
    tier: 'readWrite',
    allowedLocalTools: ['file_read', 'file_write', 'file_create', 'file_edit', 'directory_list', 'web_search', 'webpage_fetch', 'search_files', 'apply_patch', 'list_code_definition_names', 'ask_followup_question', 'run_test', 'get_file_diagnostics', 'repo_map', 'find_usage', 'grep_search', 'git_info', 'discover_tools'],
    blockedLocalTools: ['shell_execute', 'file_delete'],
    timeoutMs: 10 * 60 * 1000, // 10 min — complex multi-file edits
  },

  // Read-only — can check actual code/files for review
  reviewer: {
    tier: 'read',
    allowedLocalTools: ['file_read', 'directory_list', 'web_search', 'webpage_fetch', 'search_files', 'list_code_definition_names', 'ask_followup_question', 'get_file_diagnostics', 'repo_map', 'find_usage', 'grep_search', 'git_info', 'discover_tools'],
    timeoutMs: 5 * 60 * 1000, // 5 min
  },

  // Read-only — can look up data for analysis
  analyst: {
    tier: 'read',
    allowedLocalTools: ['file_read', 'directory_list', 'web_search', 'webpage_fetch', 'http_request'],
    timeoutMs: 5 * 60 * 1000, // 5 min
  },

  // Read-only web — can fact-check claims
  critic: {
    tier: 'read',
    allowedLocalTools: ['web_search', 'webpage_fetch'],
    timeoutMs: 3 * 60 * 1000, // 3 min
  },

  // Pure reasoning — no tools needed
  writer: {
    tier: 'none',
  },

  // Read-only reconnaissance — can inspect project structure before planning
  planner: {
    tier: 'read',
    allowedLocalTools: ['file_read', 'directory_list', 'search_files', 'list_code_definition_names', 'get_file_diagnostics', 'repo_map', 'find_usage', 'grep_search', 'git_info', 'discover_tools'],
    maxSteps: 12,
    timeoutMs: 3 * 60 * 1000, // 3 min
  },

  // Pure reasoning — no tools needed
  reflection: {
    tier: 'none',
  },

  // Orchestrator doesn't execute tools directly
  orchestrator: {
    tier: 'none',
  },
}

// ─── Tool Classification ────────────────────────────────────

/** Classify a local tool as read/write/execute for permission checking */
function classifyLocalTool(toolName: string): 'read' | 'write' | 'execute' {
  const READ_TOOLS = new Set([
    'file_read', 'directory_list', 'web_search', 'webpage_fetch',
    'http_request', 'send_notification', 'search_files', 'list_code_definition_names',
    'ask_followup_question', 'condense', 'get_file_diagnostics', 'repo_map', 'find_usage',
    'grep_search', 'git_info', 'discover_tools',
  ])
  const WRITE_TOOLS = new Set([
    'file_write', 'file_create', 'file_delete', 'file_move', 'file_edit', 'apply_patch',
  ])
  const EXECUTE_TOOLS = new Set([
    'shell_execute', 'shell_kill', 'run_test',
  ])

  if (READ_TOOLS.has(toolName)) return 'read'
  if (WRITE_TOOLS.has(toolName)) return 'write'
  if (EXECUTE_TOOLS.has(toolName)) return 'execute'
  return 'execute' // unknown tools default to most restrictive
}

// ─── Public API ─────────────────────────────────────────────

/** Get the permission config for an agent type */
export function getAgentPermissions(agentType: AgentType | string): ToolPermissionConfig {
  return AGENT_PERMISSIONS[agentType] ?? { tier: 'none' }
}

/** Check if an agent is allowed to call a specific tool */
export function canAgentCallTool(
  agentType: AgentType | string,
  toolKey: string
): { allowed: boolean; reason?: string } {
  const config = getAgentPermissions(agentType)

  // No tools at all
  if (config.tier === 'none') {
    return { allowed: false, reason: `Agent "${agentType}" has no tool access (tier: none)` }
  }

  // Full access — everything goes
  if (config.tier === 'full') {
    return { allowed: true }
  }

  // For local tools, extract the tool name
  const isLocal = toolKey.startsWith('local::')
  const toolName = isLocal ? toolKey.split('::')[1] : toolKey

  // Check explicit block list first
  if (isLocal && config.blockedLocalTools?.includes(toolName)) {
    return { allowed: false, reason: `Tool "${toolName}" is explicitly blocked for agent "${agentType}"` }
  }

  // Check explicit allow list (if defined, only these tools are permitted)
  if (isLocal && config.allowedLocalTools) {
    if (!config.allowedLocalTools.includes(toolName)) {
      return { allowed: false, reason: `Tool "${toolName}" is not in the allow-list for agent "${agentType}"` }
    }
    return { allowed: true }
  }

  // For MCP tools — allow all MCP tools for read and readWrite tiers
  // MCP tools are generally safe (they're external services, not local system access)
  if (!isLocal) {
    return { allowed: true }
  }

  // Tier-based check for local tools without explicit allow/block lists
  const classification = classifyLocalTool(toolName)

  if (config.tier === 'read' && classification !== 'read') {
    return { allowed: false, reason: `Agent "${agentType}" (tier: read) cannot use ${classification}-level tool "${toolName}"` }
  }

  if (config.tier === 'readWrite' && classification === 'execute') {
    return { allowed: false, reason: `Agent "${agentType}" (tier: readWrite) cannot use execute-level tool "${toolName}"` }
  }

  return { allowed: true }
}

/** Get the list of tools an agent is allowed to use, filtered from the full catalog */
export function filterToolsForAgent<T extends { key: string; name: string }>(
  agentType: AgentType | string,
  allTools: T[]
): T[] {
  const config = getAgentPermissions(agentType)
  if (config.tier === 'none') return []
  if (config.tier === 'full') return allTools

  return allTools.filter((tool) => canAgentCallTool(agentType, tool.key).allowed)
}

/** Check if an agent type has any tool access at all */
export function hasToolAccess(agentType: AgentType | string): boolean {
  return getAgentPermissions(agentType).tier !== 'none'
}

/**
 * Build a permission config from a ModeConfig's tool groups.
 * When a mode is active, its toolGroups override the agent's default
 * permissions to enforce the mode's restrictions.
 */
export function getPermissionsForMode(mode: ModeConfig): ToolPermissionConfig {
  const allowedTools = resolveToolGroups(mode.toolGroups)
  const hasEdit = mode.toolGroups.includes('edit')
  const hasCommand = mode.toolGroups.includes('command')

  // Determine tier from tool groups
  let tier: ToolPermissionTier = 'none'
  if (hasCommand) {
    tier = 'full'
  } else if (hasEdit) {
    tier = 'readWrite'
  } else if (mode.toolGroups.length > 0) {
    tier = 'read'
  }

  return {
    tier,
    allowedLocalTools: [...allowedTools],
  }
}

/**
 * Filter tools for an agent operating in a specific mode.
 * More restrictive than either agent or mode permissions alone:
 * the tool must be allowed by BOTH the mode's tool groups AND be a
 * valid tool for the agent type.
 */
export function filterToolsForMode<T extends { key: string; name: string }>(
  mode: ModeConfig,
  allTools: T[]
): T[] {
  const modeTools = resolveToolGroups(mode.toolGroups)
  const allowsMcp = modeAllowsMcp(mode)

  return allTools.filter((tool) => {
    const isLocal = tool.key.startsWith('local::')
    const toolName = isLocal ? tool.key.split('::')[1] : tool.name

    if (isLocal) {
      return modeTools.has(toolName)
    }

    // MCP tools — only allowed if mode includes 'mcp' group
    return allowsMcp
  })
}
