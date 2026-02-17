/**
 * Streaming XML Parser — Incremental XML tool block detector for streaming LLM responses
 *
 * Unlike the batch `parseAssistantMessage()`, this parser processes text chunk-by-chunk
 * as it arrives from the LLM stream. It maintains state between `feed()` calls and
 * reports:
 *   - Text portions safe to display to the user (outside of tool blocks)
 *   - Completed tool uses as they close
 *   - Whether we're currently inside a tool block (so the UI can suppress raw XML)
 *   - Completion results from <attempt_completion>
 *
 * Usage:
 *   const parser = new StreamingXmlParser()
 *   for await (const chunk of llmStream) {
 *     const result = parser.feed(chunk)
 *     if (result.displayText) emitToUI(result.displayText)
 *     for (const tool of result.completedTools) await executeTool(tool)
 *   }
 *   const final = parser.finalize()
 */

import type { ParsedToolUse } from './xml-parser'

// Re-use the TOOL_NAMES registry from xml-parser
// We import containsToolUse just to share the tool name set indirectly,
// but we need our own set reference. Export a registration fn.
const STREAMING_TOOL_NAMES = new Set([
  // File operations
  'read_file', 'write_to_file', 'replace_in_file', 'apply_patch',
  'list_files', 'create_directory', 'file_delete', 'file_move',
  // Search
  'search_files', 'list_code_definition_names',
  // Shell
  'execute_command',
  // Network
  'http_request', 'web_search', 'webpage_fetch',
  // User interaction
  'ask_followup_question', 'attempt_completion',
  // Browser
  'browser_action',
  // Notifications
  'send_notification',
  // Agent delegation
  'delegate_to_agent',
  // Context management
  'condense',
  // Legacy
  'file_read', 'file_write', 'file_create', 'file_edit',
  'directory_list', 'shell_execute', 'shell_kill',
])

/** Register an additional tool name for streaming detection (e.g. MCP tools). */
export function registerStreamingToolName(name: string): void {
  STREAMING_TOOL_NAMES.add(name)
}

// ─── Types ──────────────────────────────────────────────────

export interface StreamingFeedResult {
  /** Text safe to display to the user right now (outside any tool block). */
  displayText: string
  /** Tool uses that just completed (closing tag received in this chunk). */
  completedTools: ParsedToolUse[]
  /** If <attempt_completion> just closed, its result text. */
  completionResult: string | null
  /** Whether we are currently inside an open tool block (suppressing display). */
  insideToolBlock: boolean
}

export interface StreamingFinalResult {
  /** All accumulated display text (full response minus tool blocks). */
  fullDisplayText: string
  /** Full raw accumulated text (everything the LLM said). */
  fullRawText: string
  /** All tool uses found across the entire stream. */
  allTools: ParsedToolUse[]
  /** Completion result if found. */
  completionResult: string | null
}

// ─── Parser State ───────────────────────────────────────────

type ParserState =
  | 'text'           // Normal text — safe to display
  | 'potential-tag'   // Saw '<', accumulating to identify if it's a tool tag
  | 'inside-tool'     // Inside a known tool block — accumulating until </tool>

// ─── Streaming XML Parser ───────────────────────────────────

export class StreamingXmlParser {
  private state: ParserState = 'text'
  private buffer = ''           // Accumulated raw text for current state
  private fullRaw = ''          // Complete raw text accumulated
  private fullDisplay = ''      // Complete display text accumulated

  // Tool block tracking
  private currentToolName = ''
  private currentToolStart = 0  // Offset in fullRaw where tool block started
  private toolContent = ''      // Content inside the current tool block

  // Results
  private allTools: ParsedToolUse[] = []
  private completionResult: string | null = null

  /**
   * Feed a chunk of text from the LLM stream.
   * Returns what can be displayed and any completed tools.
   */
  feed(chunk: string): StreamingFeedResult {
    const result: StreamingFeedResult = {
      displayText: '',
      completedTools: [],
      completionResult: null,
      insideToolBlock: false,
    }

    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i]
      this.fullRaw += char

      switch (this.state) {
        case 'text':
          if (char === '<') {
            // Might be starting a tool tag — switch to potential-tag state
            this.state = 'potential-tag'
            this.buffer = '<'
          } else {
            result.displayText += char
            this.fullDisplay += char
          }
          break

        case 'potential-tag':
          this.buffer += char

          if (char === '>' || char === '\n') {
            // Tag closed or newline — check if it's a tool opening tag
            // Supports qualified names like <local::directory_list> or <bundled::fs::tool>
            const match = this.buffer.match(/^<([a-z][a-z0-9_:.-]*)(?:\s*>|\s*\n)$/)
            if (match) {
              const tagName = match[1]
              const shortName = tagName.includes('::') ? tagName.split('::').pop()! : tagName
              if (STREAMING_TOOL_NAMES.has(tagName) || STREAMING_TOOL_NAMES.has(shortName)) {
                // It's a known tool! Enter tool block state
                this.state = 'inside-tool'
                this.currentToolName = tagName
                this.currentToolStart = this.fullRaw.length - this.buffer.length
                this.toolContent = ''
              } else {
                // Not a tool tag — flush buffer as display text
                result.displayText += this.buffer
                this.fullDisplay += this.buffer
                this.state = 'text'
              }
            } else {
              // No regex match at all — flush buffer as display text
              result.displayText += this.buffer
              this.fullDisplay += this.buffer
              this.state = 'text'
            }
            this.buffer = ''
          } else if (this.buffer.length > 60) {
            // Too long for a tool name — not a tool tag
            result.displayText += this.buffer
            this.fullDisplay += this.buffer
            this.buffer = ''
            this.state = 'text'
          }
          break

        case 'inside-tool':
          this.toolContent += char
          result.insideToolBlock = true

          // Check if we've received the closing tag
          const closeTag = `</${this.currentToolName}>`
          if (this.toolContent.endsWith(closeTag)) {
            // Tool block complete!
            const innerContent = this.toolContent.slice(0, -closeTag.length)
            const endIndex = this.fullRaw.length

            if (this.currentToolName === 'attempt_completion') {
              // Extract the <result> param or use inner content
              const resultMatch = innerContent.match(/<result>([\s\S]*?)<\/result>/)
              this.completionResult = resultMatch
                ? resultMatch[1].replace(/^\n/, '').replace(/\n$/, '')
                : innerContent.trim()
              result.completionResult = this.completionResult
            } else {
              const params = this.parseToolParams(innerContent)
              const toolUse: ParsedToolUse = {
                tool: this.currentToolName,
                params,
                startIndex: this.currentToolStart,
                endIndex,
              }
              this.allTools.push(toolUse)
              result.completedTools.push(toolUse)
            }

            // Reset to text state
            this.currentToolName = ''
            this.toolContent = ''
            this.state = 'text'
            result.insideToolBlock = false
          }
          break
      }
    }

    // If we're still in potential-tag at end of chunk, keep buffering
    // (the tag might complete in the next chunk)

    return result
  }

  /**
   * Finalize parsing — flush any remaining buffer and return final results.
   * Call this after the LLM stream ends.
   */
  finalize(): StreamingFinalResult {
    // If we're in potential-tag state, flush buffer as text
    if (this.state === 'potential-tag' && this.buffer) {
      this.fullDisplay += this.buffer
      this.buffer = ''
    }

    // If we're inside an unclosed tool block, the tool is incomplete
    // (edge case — LLM cut off mid-tool). Treat the content as display text.
    if (this.state === 'inside-tool' && this.toolContent) {
      const openTag = `<${this.currentToolName}>`
      this.fullDisplay += openTag + this.toolContent
    }

    this.state = 'text'

    return {
      fullDisplayText: this.fullDisplay.trim(),
      fullRawText: this.fullRaw,
      allTools: this.allTools,
      completionResult: this.completionResult,
    }
  }

  /**
   * Reset parser state for reuse across loop iterations.
   */
  reset(): void {
    this.state = 'text'
    this.buffer = ''
    this.fullRaw = ''
    this.fullDisplay = ''
    this.currentToolName = ''
    this.currentToolStart = 0
    this.toolContent = ''
    this.allTools = []
    this.completionResult = null
  }

  // ─── Internal helpers ─────────────────────────────────────

  /**
   * Parse <param>value</param> pairs from tool block inner content.
   * Mirrors parseToolParams from xml-parser.ts.
   */
  private parseToolParams(inner: string): Record<string, string> {
    const params: Record<string, string> = {}
    let cursor = 0

    while (cursor < inner.length) {
      const tagStart = inner.indexOf('<', cursor)
      if (tagStart === -1) break

      const openMatch = inner.slice(tagStart).match(/^<([a-z_]+)>/)
      if (!openMatch) {
        cursor = tagStart + 1
        continue
      }

      const paramName = openMatch[1]
      const valueStart = tagStart + openMatch[0].length

      const closeTag = `</${paramName}>`
      const closeIdx = inner.indexOf(closeTag, valueStart)
      if (closeIdx === -1) {
        cursor = valueStart
        continue
      }

      let value = inner.slice(valueStart, closeIdx)
      if (value.startsWith('\n')) value = value.slice(1)
      if (value.endsWith('\n')) value = value.slice(0, -1)

      params[paramName] = value
      cursor = closeIdx + closeTag.length
    }

    return params
  }
}
