/**
 * XML Tool Parser — Parses tool-call XML blocks from LLM responses
 *
 * Cline/Roo-style XML tool protocol. The LLM embeds tool calls as XML blocks
 * within its text response:
 *
 *   I'll read the file now.
 *
 *   <read_file>
 *   <path>src/main.ts</path>
 *   </read_file>
 *
 * Advantages over JSON-in-content:
 * - Models naturally produce well-formed XML tool blocks
 * - Prose/reasoning is expected and preserved (no anti-narration needed)
 * - Multiple tool calls per response are supported
 * - Format is unambiguous — no false positives from CSS/code snippets
 */

// ─── Types ──────────────────────────────────────────────────

export interface ParsedToolUse {
  /** Tool name (e.g. "read_file", "write_to_file") */
  tool: string
  /** Extracted parameters as key-value pairs */
  params: Record<string, string>
  /** Start offset of the <tool> tag in the original content */
  startIndex: number
  /** End offset (after the closing </tool> tag) in the original content */
  endIndex: number
}

export interface ParsedMessage {
  /** Text content OUTSIDE of tool blocks (reasoning, explanation) */
  textContent: string
  /** All complete tool-call blocks found in the message */
  toolUses: ParsedToolUse[]
  /** Completion signal if <attempt_completion> was found */
  completionResult: string | null
}

// ─── Tool Names ─────────────────────────────────────────────

/**
 * All recognized tool names. Any XML block with a tag name in this set
 * is treated as a tool call. This prevents false positives from
 * arbitrary XML in code samples / conversation.
 */
const TOOL_NAMES = new Set([
  // File operations (Cline/Roo naming)
  'read_file',
  'write_to_file',
  'replace_in_file',
  'apply_patch',
  'list_files',
  'create_directory',
  'file_delete',
  'file_move',

  // Search & code understanding
  'search_files',
  'list_code_definition_names',

  // Shell
  'execute_command',

  // Network
  'http_request',
  'web_search',
  'webpage_fetch',

  // User interaction
  'ask_followup_question',
  'attempt_completion',

  // Browser
  'browser_action',

  // Notifications
  'send_notification',

  // Agent delegation
  'delegate_to_agent',

  // Context management
  'condense',

  // Legacy local:: tool names (backward compat)
  'file_read',
  'file_write',
  'file_create',
  'file_edit',
  'directory_list',
  'shell_execute',
  'shell_kill',
])

// ─── Parser ─────────────────────────────────────────────────

/**
 * Parse an assistant message for XML tool blocks.
 *
 * This is a single-pass character scanner that:
 * 1. Identifies `<tool_name>` opening tags where tool_name is a known tool
 * 2. Extracts `<param>value</param>` pairs within the tool block
 * 3. Finds the closing `</tool_name>` tag
 * 4. Returns all tool uses + surrounding text
 *
 * Non-tool XML (code samples, HTML) is left as text content.
 */
export function parseAssistantMessage(content: string): ParsedMessage {
  const toolUses: ParsedToolUse[] = []
  const textParts: string[] = []
  let completionResult: string | null = null

  let cursor = 0

  while (cursor < content.length) {
    // Find the next '<' that might start a tool tag
    const tagStart = content.indexOf('<', cursor)

    if (tagStart === -1) {
      // No more tags — rest is text
      textParts.push(content.slice(cursor))
      break
    }

    // Collect text before this tag
    if (tagStart > cursor) {
      textParts.push(content.slice(cursor, tagStart))
    }

    // Try to match an opening tag: <tool_name> or <tool_name\n (no attributes)
    const openMatch = content.slice(tagStart).match(/^<([a-z_]+)(?:\s*>|\s*\n)/)

    if (!openMatch) {
      // Not a valid opening tag — treat '<' as text
      textParts.push('<')
      cursor = tagStart + 1
      continue
    }

    const tagName = openMatch[0].endsWith('\n')
      ? openMatch[1]
      : openMatch[1]

    // Check if this is a known tool name
    if (!TOOL_NAMES.has(tagName)) {
      // Not a tool — keep as text
      textParts.push(content.slice(tagStart, tagStart + openMatch[0].length))
      cursor = tagStart + openMatch[0].length
      continue
    }

    // Found a tool opening tag — now find the closing </tool_name>
    const closeTag = `</${tagName}>`
    const closeIdx = content.indexOf(closeTag, tagStart + openMatch[0].length)

    if (closeIdx === -1) {
      // Unclosed tool block — treat the opening tag as text
      textParts.push(content.slice(tagStart, tagStart + openMatch[0].length))
      cursor = tagStart + openMatch[0].length
      continue
    }

    // Extract the inner content between <tool> and </tool>
    const innerStart = tagStart + openMatch[0].length
    const innerContent = content.slice(innerStart, closeIdx)
    const endIndex = closeIdx + closeTag.length

    // Parse parameters from inner content
    const params = parseToolParams(innerContent)

    // Handle attempt_completion specially
    if (tagName === 'attempt_completion') {
      completionResult = params.result ?? innerContent.trim()
    } else {
      toolUses.push({
        tool: tagName,
        params,
        startIndex: tagStart,
        endIndex,
      })
    }

    cursor = endIndex
  }

  return {
    textContent: textParts.join('').trim(),
    toolUses,
    completionResult,
  }
}

/**
 * Parse `<param>value</param>` pairs from the inner content of a tool block.
 *
 * Handles multi-line values (e.g. file content, diff blocks, search content):
 *   <content>
 *   line 1
 *   line 2
 *   </content>
 *
 * The leading/trailing newlines immediately after `<param>` and before `</param>`
 * are stripped, but inner newlines are preserved.
 */
function parseToolParams(inner: string): Record<string, string> {
  const params: Record<string, string> = {}
  let cursor = 0

  while (cursor < inner.length) {
    // Find the next '<' that starts a param tag
    const tagStart = inner.indexOf('<', cursor)
    if (tagStart === -1) break

    // Match opening param tag
    const openMatch = inner.slice(tagStart).match(/^<([a-z_]+)>/)
    if (!openMatch) {
      cursor = tagStart + 1
      continue
    }

    const paramName = openMatch[1]
    const valueStart = tagStart + openMatch[0].length

    // Find closing tag
    const closeTag = `</${paramName}>`
    const closeIdx = inner.indexOf(closeTag, valueStart)
    if (closeIdx === -1) {
      cursor = valueStart
      continue
    }

    // Extract value — strip single leading/trailing newline
    let value = inner.slice(valueStart, closeIdx)
    if (value.startsWith('\n')) value = value.slice(1)
    if (value.endsWith('\n')) value = value.slice(0, -1)

    params[paramName] = value
    cursor = closeIdx + closeTag.length
  }

  return params
}

// ─── Tool-to-Local Mapping ──────────────────────────────────

/**
 * Maps Cline/Roo-style tool names to existing local:: tool names.
 * This allows the XML protocol to work with the existing tool infrastructure
 * without renaming all tools at once.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  // New → existing local tool name
  'read_file': 'file_read',
  'write_to_file': 'file_write',
  'replace_in_file': 'file_edit',    // Will be updated when diff strategy lands
  'list_files': 'directory_list',
  'create_directory': 'create_directory',
  'execute_command': 'shell_execute',
  'web_search': 'web_search',
  'webpage_fetch': 'webpage_fetch',
  'http_request': 'http_request',
  'send_notification': 'send_notification',
  'file_delete': 'file_delete',
  'file_move': 'file_move',
  'apply_patch': 'apply_patch',
  'search_files': 'search_files',
  'list_code_definition_names': 'list_code_definition_names',
  'ask_followup_question': 'ask_followup_question',
  'condense': 'condense',

  // Legacy names map to themselves
  'file_read': 'file_read',
  'file_write': 'file_write',
  'file_create': 'file_create',
  'file_edit': 'file_edit',
  'directory_list': 'directory_list',
  'shell_execute': 'shell_execute',
  'shell_kill': 'shell_kill',
}

/**
 * Convert a parsed XML tool use into the format expected by the local tool provider
 * and permission system (local::tool_name + args object).
 */
export function xmlToolToLocalCall(toolUse: ParsedToolUse): {
  tool: string
  args: Record<string, unknown>
} {
  const localName = TOOL_NAME_MAP[toolUse.tool] ?? toolUse.tool
  const tool = `local::${localName}`

  // Map XML param names to existing local tool arg names
  const args = mapParamsToArgs(toolUse.tool, toolUse.params)

  return { tool, args }
}

/**
 * Map XML parameter names to the existing local tool argument names.
 * Handles naming differences between Cline/Roo conventions and our local tools.
 */
function mapParamsToArgs(
  toolName: string,
  params: Record<string, string>
): Record<string, unknown> {
  const args: Record<string, unknown> = {}

  switch (toolName) {
    case 'read_file':
    case 'file_read':
      args.path = params.path
      if (params.start_line) args.start_line = parseInt(params.start_line, 10)
      if (params.end_line) args.end_line = parseInt(params.end_line, 10)
      break

    case 'write_to_file':
    case 'file_write':
    case 'file_create':
      args.path = params.path
      args.content = params.content
      break

    case 'replace_in_file':
    case 'file_edit':
      args.path = params.path
      // For file_edit, parse diff blocks from the <diff> param
      if (params.diff) {
        const blocks = parseDiffBlocks(params.diff)
        if (blocks.length > 1) {
          // Multiple blocks → use multi-block diff mode
          args.diff_blocks = JSON.stringify(blocks.map(b => ({ search: b.search, replace: b.replace })))
        } else if (blocks.length === 1) {
          // Single block → fast path with old_string/new_string
          args.old_string = blocks[0].search
          args.new_string = blocks[0].replace
        }
      }
      // Direct old_string/new_string passthrough
      if (params.old_string) args.old_string = params.old_string
      if (params.new_string) args.new_string = params.new_string
      break

    case 'apply_patch':
      args.diff = params.diff ?? params.content ?? ''
      break

    case 'list_files':
    case 'directory_list':
      args.path = params.path
      if (params.recursive) args.recursive = params.recursive === 'true'
      break

    case 'create_directory':
      args.path = params.path
      break

    case 'execute_command':
    case 'shell_execute':
      args.command = params.command
      if (params.cwd) args.cwd = params.cwd
      if (params.background) args.background = params.background === 'true'
      if (params.timeout) args.timeout = parseInt(params.timeout, 10)
      break

    case 'search_files':
      args.path = params.path
      args.regex = params.regex
      if (params.file_pattern) args.file_pattern = params.file_pattern
      break

    case 'web_search':
      args.query = params.query
      break

    case 'webpage_fetch':
      args.url = params.url
      break

    case 'http_request':
      args.method = params.method ?? 'GET'
      args.url = params.url
      if (params.body) args.body = params.body
      if (params.headers) {
        try { args.headers = JSON.parse(params.headers) } catch { args.headers = params.headers }
      }
      break

    case 'delegate_to_agent':
      args.agent = params.agent
      args.task = params.task
      break

    case 'ask_followup_question':
      args.question = params.question
      if (params.options) {
        try { args.options = JSON.parse(params.options) } catch { /* ignore */ }
      }
      break

    case 'file_delete':
      args.path = params.path
      break

    case 'file_move':
      args.path = params.source ?? params.path
      args.destination = params.destination
      break

    case 'shell_kill':
      if (params.pid) args.pid = parseInt(params.pid, 10)
      break

    case 'send_notification':
      args.title = params.title
      if (params.body) args.body = params.body
      break

    case 'list_code_definition_names':
      args.path = params.path
      break

    case 'condense':
      // No params needed
      break

    default:
      // Pass through all params as-is for unknown/MCP tools
      Object.assign(args, params)
  }

  return args
}

// ─── Diff Block Parser ──────────────────────────────────────

interface DiffBlock {
  search: string
  replace: string
}

/**
 * Parse SEARCH/REPLACE diff blocks from a <diff> parameter value:
 *
 *   <<<<<<< SEARCH
 *   old code
 *   =======
 *   new code
 *   >>>>>>> REPLACE
 */
function parseDiffBlocks(diff: string): DiffBlock[] {
  const blocks: DiffBlock[] = []
  const regex = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(diff)) !== null) {
    blocks.push({
      search: match[1],
      replace: match[2],
    })
  }

  return blocks
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Check if a string contains any XML tool blocks.
 * Quick pre-check before running the full parser.
 */
export function containsToolUse(content: string): boolean {
  for (const toolName of TOOL_NAMES) {
    if (content.includes(`<${toolName}>`)) return true
    if (content.includes(`<${toolName}\n`)) return true
  }
  return false
}

/**
 * Check if a string contains an attempt_completion block.
 */
export function containsCompletion(content: string): boolean {
  return content.includes('<attempt_completion>') && content.includes('</attempt_completion>')
}

/**
 * Register additional tool names (e.g. MCP tools discovered at runtime).
 */
export function registerToolName(name: string): void {
  TOOL_NAMES.add(name)
}
