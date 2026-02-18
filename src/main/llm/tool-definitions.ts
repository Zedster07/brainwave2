/**
 * Tool Definition Converters — Transform internal tool definitions to native API formats
 *
 * Converts McpTool / LocalTool definitions into the format expected by:
 * - Anthropic SDK (MiniMax M2.5, Claude) → { name, description, input_schema }
 * - OpenAI SDK (GPT, Gemini via OpenRouter) → { type: 'function', function: { name, description, parameters } }
 *
 * This replaces the XML-in-prose tool catalog (buildToolSection) with native
 * tool definitions that are passed via the API's `tools` parameter.
 */

import type { NativeToolDefinition, OpenAIToolDefinition } from './types'

// ─── Types ──────────────────────────────────────────────────

/**
 * Internal tool shape — compatible with both McpTool and LocalTool.
 * The minimum interface needed to convert to native definitions.
 */
interface ToolLike {
  /** Qualified key like "local::file_read" or "serverId::toolName" */
  key: string
  /** Human-readable name */
  name: string
  /** Tool description */
  description: string | undefined
  /** JSON Schema for the input */
  inputSchema: Record<string, unknown>
}

// ─── Anthropic Format (for M2.5 / Claude) ───────────────────

/**
 * Convert an internal tool definition to Anthropic native format.
 *
 * The tool `name` is sanitized to be API-safe:
 * - Replaces `::`  with `__` (e.g. "local::file_read" → "local__file_read")
 * - Only allows [a-zA-Z0-9_-] characters
 *
 * @param tool Internal tool definition
 * @returns Anthropic-format tool definition
 */
export function toAnthropicTool(tool: ToolLike): NativeToolDefinition {
  const schema = tool.inputSchema as {
    type?: string
    properties?: Record<string, unknown>
    required?: string[]
  }

  return {
    name: sanitizeToolName(tool.key),
    description: tool.description ?? tool.name,
    input_schema: {
      type: 'object',
      properties: schema.properties ?? {},
      required: schema.required,
    },
  }
}

/**
 * Convert multiple internal tool definitions to Anthropic native format.
 */
export function toAnthropicTools(tools: ToolLike[]): NativeToolDefinition[] {
  return tools.map(toAnthropicTool)
}

// ─── OpenAI Format (for GPT / Gemini via OpenRouter) ────────

/**
 * Convert an internal tool definition to OpenAI function calling format.
 *
 * @param tool Internal tool definition
 * @returns OpenAI-format tool definition
 */
export function toOpenAITool(tool: ToolLike): OpenAIToolDefinition {
  const schema = tool.inputSchema as {
    type?: string
    properties?: Record<string, unknown>
    required?: string[]
  }

  return {
    type: 'function',
    function: {
      name: sanitizeToolName(tool.key),
      description: tool.description ?? tool.name,
      parameters: {
        type: 'object',
        properties: schema.properties ?? {},
        required: schema.required,
      },
    },
  }
}

/**
 * Convert multiple internal tool definitions to OpenAI function calling format.
 */
export function toOpenAITools(tools: ToolLike[]): OpenAIToolDefinition[] {
  return tools.map(toOpenAITool)
}

// ─── Tool Alias Map ─────────────────────────────────────────
// Common hallucinated tool names → correct API names.
// Models trained on Copilot/Cursor/Aider emit these names from training priors.
// The alias map silently auto-resolves them instead of erroring out.

const TOOL_ALIASES: Record<string, string> = {
  // File operations — most common hallucination source
  'read_file':             'local__file_read',
  'write_file':            'local__file_write',
  'create_file':           'local__file_create',
  'edit_file':             'local__file_edit',
  'delete_file':           'local__file_delete',
  'move_file':             'local__file_move',
  'rename_file':           'local__file_move',
  'list_dir':              'local__directory_list',
  'list_directory':        'local__directory_list',
  'ls':                    'local__directory_list',
  'mkdir':                 'local__create_directory',
  'make_directory':        'local__create_directory',
  'replace_in_file':       'local__file_edit',
  'replace_string_in_file': 'local__file_edit',
  'multi_replace_string_in_file': 'local__file_edit',
  'insert_code_at_line':   'local__file_edit',

  // Shell / terminal
  'run_in_terminal':       'local__shell_execute',
  'run_command':           'local__shell_execute',
  'execute_command':       'local__shell_execute',
  'terminal_execute':      'local__shell_execute',
  'run_terminal_command':  'local__shell_execute',
  'bash':                  'local__shell_execute',
  'shell':                 'local__shell_execute',

  // Search
  'grep':                  'local__grep_search',
  'ripgrep':               'local__grep_search',
  'search':                'local__search_files',
  'find_files':            'local__search_files',
  'file_search':           'local__search_files',
  'code_search':           'local__grep_search',
  'semantic_search':       'local__grep_search',
  'codebase_search':       'local__grep_search',

  // Web
  'browser_navigate':      'local__webpage_fetch',
  'fetch_webpage':         'local__webpage_fetch',
  'web_fetch':             'local__webpage_fetch',
  'http':                  'local__http_request',
  'curl':                  'local__http_request',
  'fetch':                 'local__http_request',

  // Git
  'git_status':            'local__git_info',
  'git_diff':              'local__git_info',
  'git_log':               'local__git_info',

  // Misc
  'get_errors':            'local__get_file_diagnostics',
  'diagnostics':           'local__get_file_diagnostics',
  'run_tests':             'local__run_test',
  'test':                  'local__run_test',
  'ask_user':              'local__ask_followup_question',
  'ask_question':          'local__ask_followup_question',
  'ask_questions':         'local__ask_followup_question',
  'notify':                'local__send_notification',
  'notification':          'local__send_notification',
  'tool_search':           'local__discover_tools',
  'tool_search_tool_regex': 'local__discover_tools',
  'find_tool':             'local__discover_tools',
  'list_tools':            'local__discover_tools',

  // Delegation
  'runSubagent':           'delegate_to_agent',
  'run_subagent':          'delegate_to_agent',
  'spawn_agent':           'delegate_to_agent',
  'sub_agent':             'delegate_to_agent',

  // Document generation
  'create_xlsx':           'local__generate_xlsx',
  'create_excel':          'local__generate_xlsx',
  'write_excel':           'local__generate_xlsx',
  'make_spreadsheet':      'local__generate_xlsx',
  'create_spreadsheet':    'local__generate_xlsx',
  'excel':                 'local__generate_xlsx',
  'create_pdf':            'local__generate_pdf',
  'write_pdf':             'local__generate_pdf',
  'make_pdf':              'local__generate_pdf',
  'create_docx':           'local__generate_docx',
  'write_docx':            'local__generate_docx',
  'create_document':       'local__generate_docx',
  'create_pptx':           'local__generate_pptx',
  'write_pptx':            'local__generate_pptx',
  'create_presentation':   'local__generate_pptx',
}

// ─── Name Mapping ───────────────────────────────────────────

/**
 * Bidirectional name mapping between API-safe names and internal tool keys.
 * Used to translate tool calls from the API response back to internal keys.
 *
 * Also includes alias resolution: common hallucinated tool names (from model
 * training priors) are silently auto-resolved to the correct tool.
 */
export class ToolNameMap {
  private keyToApi = new Map<string, string>()
  private apiToKey = new Map<string, string>()
  private toolDescriptions = new Map<string, string>()

  constructor(tools: ToolLike[]) {
    for (const tool of tools) {
      const apiName = sanitizeToolName(tool.key)
      this.keyToApi.set(tool.key, apiName)
      this.apiToKey.set(apiName, tool.key)
      if (tool.description) {
        this.toolDescriptions.set(apiName, tool.description)
      }
    }
  }

  /** Convert internal key (e.g. "local::file_read") to API name (e.g. "local__file_read") */
  toApiName(internalKey: string): string {
    return this.keyToApi.get(internalKey) ?? sanitizeToolName(internalKey)
  }

  /** Convert API name back to internal key (e.g. "local__file_read" → "local::file_read") */
  toInternalKey(apiName: string): string {
    // 1. Exact match
    const exact = this.apiToKey.get(apiName)
    if (exact) return exact

    // 2. Fuzzy suffix match — handles model prepending unknown prefixes
    //    e.g. "bundled__brave-search__brave_web_search" matches known "brave-search__brave_web_search"
    for (const [knownApi, key] of this.apiToKey) {
      if (apiName.endsWith(knownApi) || apiName.endsWith(`__${knownApi}`)) {
        console.warn(
          `[ToolNameMap] Fuzzy match: "${apiName}" → "${key}" (matched suffix "${knownApi}")`
        )
        return key
      }
    }

    // 3. Fallback to simple unsanitize
    return unsanitizeToolName(apiName)
  }

  /** Check if an API name is known (exact or fuzzy match) */
  hasApiName(apiName: string): boolean {
    return this.apiToKey.has(apiName)
  }

  /**
   * Check if a tool name resolves to a KNOWN registered tool.
   * Unlike hasApiName(), this also checks fuzzy suffix matching AND alias map.
   * Returns false for hallucinated tool names that would fall through to unsanitize.
   */
  isKnownTool(apiName: string): boolean {
    // Exact match
    if (this.apiToKey.has(apiName)) return true
    // Alias match
    if (TOOL_ALIASES[apiName] && this.apiToKey.has(TOOL_ALIASES[apiName])) return true
    // Fuzzy suffix match
    for (const knownApi of this.apiToKey.keys()) {
      if (apiName.endsWith(knownApi) || apiName.endsWith(`__${knownApi}`)) return true
    }
    return false
  }

  /**
   * Resolve a tool alias to the correct API name.
   * Returns the resolved API name if an alias exists and the target tool is registered,
   * or null if no alias matches.
   */
  resolveAlias(apiName: string): { resolved: string; internalKey: string } | null {
    const target = TOOL_ALIASES[apiName]
    if (!target) return null
    // Check if the alias target is a registered tool
    const internalKey = this.apiToKey.get(target)
    if (internalKey) {
      return { resolved: target, internalKey }
    }
    return null
  }

  /**
   * Get the description of a tool by its API name.
   * Returns undefined if the tool is not found.
   */
  getToolDescription(apiName: string): string | undefined {
    return this.toolDescriptions.get(apiName)
  }

  /**
   * Build a compact tool catalog string listing all available tools.
   * Used for error recovery — injected into conversation when model is confused.
   */
  buildToolCatalog(): string {
    const lines: string[] = ['Available tools (use EXACT names):']
    for (const [apiName, key] of this.apiToKey) {
      const desc = this.toolDescriptions.get(apiName)
      const shortDesc = desc ? ` — ${desc.slice(0, 80)}` : ''
      lines.push(`  • ${apiName}${shortDesc}`)
    }
    return lines.join('\n')
  }

  /**
   * Suggest the closest known tool names for a hallucinated tool name.
   * Uses substring matching on the base name (after stripping prefixes).
   * Returns up to 3 suggestions sorted by similarity.
   */
  suggestSimilar(apiName: string, maxSuggestions = 3): string[] {
    const target = apiName.replace(/^.*__/, '').toLowerCase()
    const scored: Array<{ name: string; score: number }> = []

    for (const [knownApi, key] of this.apiToKey) {
      const knownBase = knownApi.replace(/^.*__/, '').toLowerCase()
      // Score: shared words/fragments
      const targetWords = new Set(target.split(/[_-]/))
      const knownWords = new Set(knownBase.split(/[_-]/))
      let shared = 0
      for (const w of targetWords) {
        if (w.length > 1 && (knownWords.has(w) || knownBase.includes(w))) shared++
      }
      for (const w of knownWords) {
        if (w.length > 1 && target.includes(w)) shared++
      }
      if (shared > 0) {
        scored.push({ name: key, score: shared })
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSuggestions)
      .map(s => s.name)
  }

  /** Get all registered API names */
  getAllApiNames(): string[] {
    return [...this.apiToKey.keys()]
  }
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Sanitize a tool key for use as an API tool name.
 * - Replaces `::` with `__`
 * - Strips characters that aren't [a-zA-Z0-9_-]
 * - Ensures the name starts with a letter or underscore
 */
function sanitizeToolName(key: string): string {
  let name = key.replace(/::/g, '__')
  name = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  // Ensure starts with letter or underscore
  if (name && !/^[a-zA-Z_]/.test(name)) {
    name = '_' + name
  }
  return name
}

/**
 * Reverse sanitization: convert API name back to internal key format.
 * - Replaces ALL `__` with `::` to restore the full tool key.
 *   Server IDs may contain `::` (e.g. "bundled::brave-search"), and
 *   sanitizeToolName converts all `::` → `__`, so we must restore all of them.
 */
function unsanitizeToolName(apiName: string): string {
  return apiName.replace(/__/g, '::')
}

/**
 * Build a delegation tool definition for native tool calling.
 * This replaces the XML-based delegate_to_agent protocol.
 */
export function buildDelegationToolDefinition(
  allowedAgents: string[],
): NativeToolDefinition {
  return {
    name: 'delegate_to_agent',
    description:
      'Delegate a sub-task to a specialist agent. ' +
      `Available agents: ${allowedAgents.join(', ')}. ` +
      'Use this when a task requires expertise outside your specialization.',
    input_schema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: `The agent type to delegate to. Must be one of: ${allowedAgents.join(', ')}`,
          enum: allowedAgents,
        },
        task: {
          type: 'string',
          description: 'A clear, detailed description of the sub-task to delegate.',
        },
      },
      required: ['agent', 'task'],
    },
  }
}

/**
 * Build a parallel delegation tool definition for native tool calling.
 */
export function buildParallelDelegationToolDefinition(
  allowedAgents: string[],
): NativeToolDefinition {
  return {
    name: 'use_subagents',
    description:
      'Run multiple sub-tasks in parallel using specialist agents. ' +
      `Available agents: ${allowedAgents.join(', ')}. ` +
      'Use when tasks are independent and can run concurrently.',
    input_schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Array of tasks to run in parallel.',
          items: {
            type: 'object',
            properties: {
              agent: {
                type: 'string',
                description: `Agent type. Must be one of: ${allowedAgents.join(', ')}`,
                enum: allowedAgents,
              },
              task: {
                type: 'string',
                description: 'Description of the sub-task.',
              },
            },
            required: ['agent', 'task'],
          },
        },
      },
      required: ['tasks'],
    },
  }
}

/**
 * Build the completion signal tool definition.
 * Replaces the XML <attempt_completion> block.
 */
export function buildCompletionToolDefinition(): NativeToolDefinition {
  return {
    name: 'attempt_completion',
    description:
      'Signal that the task is complete. Call this when you have finished the task ' +
      'and want to provide the final result to the user. Include a clear summary ' +
      'of what was accomplished.',
    input_schema: {
      type: 'object',
      properties: {
        result: {
          type: 'string',
          description: 'The final result or summary of the completed task.',
        },
      },
      required: ['result'],
    },
  }
}
