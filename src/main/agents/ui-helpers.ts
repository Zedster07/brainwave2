/**
 * UI Helpers — Formatting and event emission utilities for the agent UI
 *
 * Extracted from BaseAgent to decouple UI-facing logic from the core agent class.
 * These are pure functions (no class state) that format tool results for the
 * live activity feed and emit structured events for rich tool cards.
 */
import type { EventBus, AgentType } from './event-bus'

// ─── Tool Call Info Emission ────────────────────────────────

export interface ToolCallInfoOpts {
    taskId: string
    step: number
    tool: string
    args: Record<string, unknown>
    success: boolean
    summary: string
    duration?: number
    resultPreview?: string
}

/**
 * Emit structured tool-call-info for the UI to render rich tool cards.
 * Called alongside agent:tool-result at every tool execution point.
 */
export function emitToolCallInfo(
    bus: EventBus,
    agentType: AgentType,
    opts: ToolCallInfoOpts,
): void {
    const toolName = opts.tool.split('::').pop() ?? opts.tool
    bus.emitEvent('agent:tool-call-info', {
        taskId: opts.taskId,
        agentType,
        step: opts.step,
        tool: opts.tool,
        toolName,
        args: opts.args,
        success: opts.success,
        summary: opts.summary,
        duration: opts.duration,
        resultPreview: opts.resultPreview,
    })
}

// ─── UI Summary ─────────────────────────────────────────────

/**
 * Create a clean, human-readable 1-line summary for a tool result.
 * This is what the user sees in the live activity feed — NOT the raw content.
 */
export function summarizeForUI(
    tool: string,
    args: Record<string, unknown>,
    result: { success: boolean; content: string },
): string {
    const toolName = tool.split('::').pop() ?? tool
    const path = args.path ? String(args.path) : ''
    const fileName = path ? path.replace(/\\/g, '/').split('/').pop() ?? path : ''

    if (!result.success) {
        // For failures, show a short reason
        const reason = result.content.slice(0, 120).split('\n')[0]
        return `Failed: ${reason}`
    }

    switch (toolName) {
        case 'file_read': {
            // Extract line info if present
            const lineMatch = result.content.match(/^\[Lines (\d+)-(\d+) of (\d+) total\]/)
            if (lineMatch) {
                return `Read ${fileName} (lines ${lineMatch[1]}-${lineMatch[2]} of ${lineMatch[3]})`
            }
            const lineCount = result.content.split('\n').length
            return `Read ${fileName} (${lineCount} lines)`
        }
        case 'file_write':
            return `Wrote ${fileName} (${formatBytes(args.content)})`
        case 'file_create':
            return `Created ${fileName} (${formatBytes(args.content)})`
        case 'file_delete':
            return `Deleted ${fileName}`
        case 'file_move':
            return `Moved ${fileName} → ${String(args.destination ?? '').replace(/\\/g, '/').split('/').pop()}`
        case 'file_edit': {
            const editMatch = result.content.match(/\((.+?),\s*(\d+)\s*bytes/)
            return editMatch
                ? `Edited ${fileName} (${editMatch[1]})`
                : `Edited ${fileName}`
        }
        case 'directory_list': {
            const entries = result.content.split('\n').filter(l => l.trim()).length
            return `Listed ${fileName || path || 'directory'} (${entries} entries)`
        }
        case 'create_directory':
            return `Created directory ${fileName || path}`
        case 'shell_execute': {
            const cmd = String(args.command ?? '').split('\n')[0]
            const shortCmd = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd
            return `Ran: ${shortCmd}`
        }
        case 'http_request': {
            const statusMatch = result.content.match(/^HTTP (\d+)\s*(.*)/)
            const url = String(args.url ?? '')
            const host = url.match(/\/\/([^/]+)/)?.[1] ?? url.slice(0, 50)
            return statusMatch
                ? `${String(args.method ?? 'GET')} ${host} → ${statusMatch[1]} ${statusMatch[2]}`
                : `HTTP request to ${host}`
        }
        case 'web_search':
            return `Searched: "${String(args.query ?? '').slice(0, 60)}"`
        case 'webpage_fetch': {
            const u = String(args.url ?? '')
            const h = u.match(/\/\/([^/]+)/)?.[1] ?? u.slice(0, 50)
            return `Fetched page: ${h}`
        }
        case 'send_notification':
            return `Sent notification: "${String(args.title ?? '')}"`
        default: {
            // MCP tools — use first 100 chars of content
            const first = result.content.slice(0, 100).split('\n')[0]
            return first.length < result.content.length ? `${first}...` : first
        }
    }
}

// ─── Reasoning Extraction ───────────────────────────────────

/**
 * Extract the model's reasoning/explanation text from its response.
 * The model often outputs prose before the JSON tool call — this grabs that.
 * Returns a clean 1-2 sentence summary, or null if nothing meaningful.
 */
export function extractReasoning(content: string): string | null {
    if (!content) return null

    // Find the first '{' that starts a JSON object (the tool call)
    let braceDepth = 0
    let jsonStart = -1
    for (let i = 0; i < content.length; i++) {
        if (content[i] === '{') {
            if (braceDepth === 0) jsonStart = i
            braceDepth++
        } else if (content[i] === '}') {
            braceDepth--
            if (braceDepth === 0 && jsonStart >= 0) {
                // Validate it's actually JSON with a "tool" key
                const candidate = content.slice(jsonStart, i + 1)
                if (candidate.includes('"tool"') || candidate.includes('"name"')) {
                    break // Found the tool call JSON — text before jsonStart is reasoning
                }
                jsonStart = -1 // Not a tool call, keep searching
            }
        }
    }

    if (jsonStart <= 0) return null

    // Get text before the JSON tool call
    let reasoning = content.slice(0, jsonStart).trim()
    if (!reasoning || reasoning.length < 5) return null

    // Clean up: remove markdown artifacts, excessive whitespace
    reasoning = reasoning
        .replace(/```[\s\S]*?```/g, '') // remove code blocks
        .replace(/\*\*/g, '')           // remove bold markers
        .replace(/#{1,3}\s*/g, '')      // remove heading markers
        .replace(/\n+/g, ' ')          // collapse newlines
        .trim()

    if (reasoning.length < 5) return null

    // Take first 1-2 sentences, cap at 150 chars
    const sentences = reasoning.match(/[^.!?]+[.!?]+/g)
    if (sentences && sentences.length > 0) {
        reasoning = sentences.slice(0, 2).join(' ').trim()
    }
    if (reasoning.length > 150) {
        reasoning = reasoning.slice(0, 147) + '...'
    }

    return reasoning
}

// ─── Utilities ──────────────────────────────────────────────

/** Format byte count from content arg for UI display */
export function formatBytes(content: unknown): string {
    if (typeof content !== 'string') return '0 bytes'
    const bytes = Buffer.byteLength(content, 'utf-8')
    if (bytes < 1024) return `${bytes} bytes`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
