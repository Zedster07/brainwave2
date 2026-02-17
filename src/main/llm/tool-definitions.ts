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

// ─── Name Mapping ───────────────────────────────────────────

/**
 * Bidirectional name mapping between API-safe names and internal tool keys.
 * Used to translate tool calls from the API response back to internal keys.
 */
export class ToolNameMap {
  private keyToApi = new Map<string, string>()
  private apiToKey = new Map<string, string>()

  constructor(tools: ToolLike[]) {
    for (const tool of tools) {
      const apiName = sanitizeToolName(tool.key)
      this.keyToApi.set(tool.key, apiName)
      this.apiToKey.set(apiName, tool.key)
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

  /** Check if an API name is known */
  hasApiName(apiName: string): boolean {
    return this.apiToKey.has(apiName)
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
