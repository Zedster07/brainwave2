/**
 * Approval System — 3-Tier tool execution approval
 *
 * Provides a configurable gate between tool permission checks and actual execution.
 * Permissions (permissions.ts) answer "can this agent TYPE call this tool?" (hardcoded).
 * Approval answers "should the USER approve this call before it executes?" (user-configurable).
 *
 * Approval modes:
 *   - autonomous:        Execute everything without asking (current default behavior)
 *   - auto-approve-reads: Auto-approve read-only tools, require approval for writes/executes
 *   - approve-all:       Require approval for every tool call
 *
 * The approval flow follows the same event-bus pattern as ask_followup_question:
 *   1. Emit 'agent:approval-needed' event → forwarded to renderer via IPC
 *   2. Block on a Promise that resolves when 'agent:approval-response' fires
 *   3. If approved → execute tool. If rejected → inject rejection into conversation.
 */

import { getEventBus } from '../agents/event-bus'

// ─── Types ──────────────────────────────────────────────────

export type ApprovalMode = 'autonomous' | 'auto-approve-reads' | 'approve-all'

export interface ApprovalSettings {
  mode: ApprovalMode
  /** Auto-approve file read operations (read_file, list_files, search_files, etc.) */
  autoApproveReads: boolean
  /** Auto-approve file write/edit operations */
  autoApproveWrites: boolean
  /** Auto-approve shell command execution */
  autoApproveExecute: boolean
  /** Auto-approve MCP tool calls */
  autoApproveMcp: boolean
}

export interface ApprovalRequest {
  approvalId: string
  taskId: string
  agentType: string
  tool: string
  args: Record<string, unknown>
  /** Human-readable summary of what the tool will do */
  summary: string
  /** For file edits: diff preview text */
  diffPreview?: string
  /** Tool safety classification */
  safetyLevel: 'safe' | 'write' | 'execute' | 'dangerous'
}

export interface ApprovalResponse {
  approvalId: string
  approved: boolean
  /** Optional user feedback to inject into conversation */
  feedback?: string
  /** Reason for rejection */
  reason?: string
}

// ─── Constants ──────────────────────────────────────────────

/** Default settings — autonomous mode (backward-compatible, no approvals) */
export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = {
  mode: 'autonomous',
  autoApproveReads: true,
  autoApproveWrites: false,
  autoApproveExecute: false,
  autoApproveMcp: true,
}

/** Approval wait timeout (5 minutes) */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

// ─── Tool Safety Classification ─────────────────────────────

const SAFE_TOOLS = new Set([
  'read_file', 'file_read',
  'list_files', 'directory_list',
  'search_files',
  'list_code_definition_names',
  'ask_followup_question',
  'condense',
  'web_search',
  'webpage_fetch',
])

const WRITE_TOOLS = new Set([
  'write_to_file', 'file_write', 'file_create',
  'replace_in_file', 'file_edit',
  'apply_patch',
  'create_directory',
])

const EXECUTE_TOOLS = new Set([
  'shell_execute', 'execute_command',
])

const DANGEROUS_TOOLS = new Set([
  'file_delete', 'file_move',
])

export type ToolSafetyLevel = 'safe' | 'write' | 'execute' | 'dangerous'

/** Classify a tool by its safety level */
export function classifyToolSafety(toolName: string): ToolSafetyLevel {
  // Strip namespace prefix (e.g. "local::file_read" → "file_read")
  const baseName = toolName.includes('::') ? toolName.split('::').pop()! : toolName

  if (SAFE_TOOLS.has(baseName)) return 'safe'
  if (DANGEROUS_TOOLS.has(baseName)) return 'dangerous'
  if (WRITE_TOOLS.has(baseName)) return 'write'
  if (EXECUTE_TOOLS.has(baseName)) return 'execute'

  // MCP tools and unknown tools default to 'execute' (require approval in non-autonomous mode)
  return 'execute'
}

// ─── Approval Logic ─────────────────────────────────────────

/**
 * Check whether a specific tool call requires user approval given the current settings.
 * Returns true if the tool execution should be paused for user confirmation.
 *
 * @param toolName — tool key (e.g. "local::file_read" or "serverId::toolName")
 * @param settings — global approval settings from user preferences
 * @param mcpAutoApproved — if true, this specific tool is in its MCP server's autoApprove list
 */
export function requiresApproval(toolName: string, settings: ApprovalSettings, mcpAutoApproved = false): boolean {
  // Autonomous mode — never ask
  if (settings.mode === 'autonomous') return false

  // Approve-all mode — always ask (unless per-tool auto-approved in MCP config)
  if (settings.mode === 'approve-all') {
    // Per-tool MCP auto-approve overrides approve-all for that specific tool
    if (mcpAutoApproved) return false
    return true
  }

  // auto-approve-reads mode — check per-category overrides
  const safety = classifyToolSafety(toolName)

  // MCP tools (not local) — check per-tool auto-approve first, then global MCP auto-approve
  const isLocal = toolName.startsWith('local::') || !toolName.includes('::')
  if (!isLocal) {
    if (mcpAutoApproved) return false
    if (settings.autoApproveMcp) return false
  }

  switch (safety) {
    case 'safe':
      return !settings.autoApproveReads
    case 'write':
      return !settings.autoApproveWrites
    case 'execute':
      return !settings.autoApproveExecute
    case 'dangerous':
      // Dangerous tools always require approval unless fully autonomous
      return true
    default:
      return true
  }
}

// ─── Approval Request/Response ──────────────────────────────

let approvalCounter = 0

/**
 * Build a human-readable summary of what a tool call will do.
 */
export function buildToolSummary(tool: string, args: Record<string, unknown>): string {
  const baseName = tool.includes('::') ? tool.split('::').pop()! : tool

  switch (baseName) {
    case 'file_read':
    case 'read_file':
      return `Read file: ${args.path ?? args.file_path ?? 'unknown'}`

    case 'file_write':
    case 'write_to_file':
    case 'file_create':
      return `Write file: ${args.path ?? args.file_path ?? 'unknown'}`

    case 'file_edit':
    case 'replace_in_file': {
      const path = args.path ?? args.file_path ?? 'unknown'
      return `Edit file: ${path}`
    }

    case 'apply_patch':
      return `Apply multi-file patch`

    case 'file_delete':
      return `DELETE file: ${args.path ?? 'unknown'} (irreversible)`

    case 'file_move':
      return `Move file: ${args.source ?? args.from ?? 'unknown'} → ${args.destination ?? args.to ?? 'unknown'}`

    case 'shell_execute':
    case 'execute_command': {
      const cmd = String(args.command ?? args.cmd ?? '').slice(0, 200)
      return `Execute command: ${cmd}`
    }

    case 'directory_list':
    case 'list_files':
      return `List directory: ${args.path ?? args.directory ?? '.'}`

    case 'search_files':
      return `Search files for: ${args.pattern ?? args.regex ?? args.query ?? 'unknown'}`

    case 'web_search':
      return `Web search: ${args.query ?? 'unknown'}`

    default:
      return `Call tool: ${baseName}`
  }
}

/**
 * Request user approval for a tool call. Blocks until the user responds or timeout.
 *
 * Uses the same event bus Promise pattern as ask_followup_question:
 * 1. Emit 'agent:approval-needed' → forwarded to renderer via IPC
 * 2. Wait for 'agent:approval-response' with matching approvalId
 * 3. Return the user's decision
 */
export async function requestApproval(
  taskId: string,
  agentType: string,
  tool: string,
  args: Record<string, unknown>,
  diffPreview?: string
): Promise<ApprovalResponse> {
  const bus = getEventBus()
  const approvalId = `approval-${Date.now()}-${++approvalCounter}`
  const safety = classifyToolSafety(tool)
  const summary = buildToolSummary(tool, args)

  // Emit the approval request
  bus.emitEvent('agent:approval-needed', {
    approvalId,
    taskId,
    agentType,
    tool,
    args,
    summary,
    diffPreview,
    safetyLevel: safety,
  })

  console.log(`[Approval] Waiting for user approval: ${approvalId} (${tool})`)

  // Wait for the matching response (same pattern as askFollowupQuestion)
  return new Promise<ApprovalResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      // On timeout, auto-reject to avoid hanging forever
      console.warn(`[Approval] Timed out waiting for approval: ${approvalId}`)
      resolve({
        approvalId,
        approved: false,
        reason: 'Approval timed out (5 minutes). Operation was rejected for safety.',
      })
    }, APPROVAL_TIMEOUT_MS)

    const cleanup = bus.onEvent('agent:approval-response', (data) => {
      if (data.approvalId === approvalId) {
        clearTimeout(timer)
        cleanup()
        console.log(`[Approval] User ${data.approved ? 'approved' : 'rejected'}: ${approvalId}`)
        resolve(data)
      }
    })
  })
}

/**
 * Load approval settings from the settings store.
 * Falls back to DEFAULT_APPROVAL_SETTINGS if not configured.
 */
export function getDefaultApprovalSettings(): ApprovalSettings {
  return { ...DEFAULT_APPROVAL_SETTINGS }
}
