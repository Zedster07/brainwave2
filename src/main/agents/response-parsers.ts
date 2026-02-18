/**
 * Response Parsers — Extract tool calls and signals from LLM text output
 *
 * Extracted from BaseAgent. These are pure functions for parsing JSON tool
 * calls, done signals, and detecting narration in LLM responses.
 * Used exclusively by the XML tool runner (legacy protocol).
 */

// ─── JSON Object Extraction ────────────────────────────────

/**
 * Extract ALL balanced JSON-like objects from a string that may contain
 * surrounding prose. Yields each `{...}` candidate so the caller can
 * try JSON.parse on each until one is valid.
 * This fixes the bug where CSS snippets like `{ opacity: 1; }` appear
 * before the actual tool-call JSON, causing the old extractFirstJsonObject
 * to grab the wrong block.
 */
export function* extractAllJsonObjects(text: string): Generator<string> {
    let searchFrom = 0
    while (searchFrom < text.length) {
        const start = text.indexOf('{', searchFrom)
        if (start === -1) return

        let depth = 0
        let inString = false
        let escape = false
        let foundEnd = -1
        for (let i = start; i < text.length; i++) {
            const ch = text[i]
            if (escape) { escape = false; continue }
            if (ch === '\\' && inString) { escape = true; continue }
            if (ch === '"' && !escape) { inString = !inString; continue }
            if (inString) continue
            if (ch === '{') depth++
            else if (ch === '}') {
                depth--
                if (depth === 0) {
                    foundEnd = i
                    break
                }
            }
        }

        if (foundEnd !== -1) {
            yield text.slice(start, foundEnd + 1)
            searchFrom = foundEnd + 1
        } else {
            // Unbalanced — skip past this '{'
            searchFrom = start + 1
        }
    }
}

/** Legacy helper — returns the first balanced JSON object (used by parseDoneSignal) */
export function extractFirstJsonObject(text: string): string | null {
    for (const obj of extractAllJsonObjects(text)) {
        return obj
    }
    return null
}

/** Quick check: does this string look like a tool call JSON? */
export function looksLikeToolCall(s: string): boolean {
    try {
        const p = JSON.parse(s.trim())
        return !!(p.tool && typeof p.tool === 'string')
    } catch {
        return false
    }
}

// ─── Tool Call Parsing ──────────────────────────────────────

/**
 * Parse a tool call from the LLM's response.
 * Handles: pure JSON, markdown code blocks, [TOOL_CALL] markers, and mixed prose.
 */
export function parseToolCall(
    content: string,
    agentType: string,
): { tool: string; args: Record<string, unknown> } | null {
    if (parseDoneSignal(content, agentType)) return null

    const extractTool = (parsed: Record<string, unknown>): { tool: string; args: Record<string, unknown> } | null => {
        if (parsed.tool && typeof parsed.tool === 'string') {
            return { tool: parsed.tool, args: (parsed.args as Record<string, unknown>) ?? {} }
        }
        if (parsed.done === true && typeof parsed.summary === 'string') {
            try {
                const nested = JSON.parse(parsed.summary)
                if (nested.tool && typeof nested.tool === 'string') {
                    console.log(`[${agentType}] Extracted tool call from done-wrapped summary`)
                    return { tool: nested.tool, args: nested.args ?? {} }
                }
            } catch { /* not a nested tool call */ }
        }
        return null
    }

    // 1. Try full content as JSON
    try {
        const result = extractTool(JSON.parse(content))
        if (result) return result
    } catch { /* not pure JSON */ }

    // 2. Try markdown code block
    const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (jsonMatch) {
        try {
            const result = extractTool(JSON.parse(jsonMatch[1]))
            if (result) return result
        } catch { /* not valid JSON in code block */ }
    }

    // 3. Handle mixed prose + tool calls, [TOOL_CALL] markers
    const chunks = content.split(/\[TOOL_CALL\]/i)
    for (const chunk of chunks) {
        // Try ALL balanced JSON objects in this chunk, not just the first one.
        // Prose often contains CSS/code like `{ opacity: 1; }` before the real tool call.
        for (const extracted of extractAllJsonObjects(chunk)) {
            try {
                const result = extractTool(JSON.parse(extracted))
                if (result) {
                    if (chunks.length > 1) {
                        console.log(`[${agentType}] Extracted tool call from ${chunks.length} [TOOL_CALL] chunks`)
                    }
                    return result
                }
            } catch { /* not valid JSON — try next balanced object */ }
        }
    }

    return null
}

// ─── Done Signal Parsing ────────────────────────────────────

/** Parse a done signal { "done": true, "summary": "..." } from the LLM's response */
export function parseDoneSignal(content: string, agentType: string): string | null {
    const extractDone = (parsed: Record<string, unknown>): string | null => {
        if (parsed.done === true && typeof parsed.summary === 'string') {
            if (looksLikeToolCall(parsed.summary)) {
                console.log(`[${agentType}] Rejecting done signal — summary is an embedded tool call`)
                return null
            }
            return parsed.summary
        }
        return null
    }

    if (/\[TOOL_CALL\]/i.test(content)) return null

    try {
        return extractDone(JSON.parse(content))
    } catch {
        const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
        if (jsonMatch) {
            try {
                const result = extractDone(JSON.parse(jsonMatch[1]))
                if (result) return result
            } catch { /* ignore */ }
        }

        const extracted = extractFirstJsonObject(content)
        if (extracted) {
            try {
                const result = extractDone(JSON.parse(extracted))
                if (result) return result
            } catch { /* ignore */ }
        }
    }
    return null
}

// ─── Narration Detection ────────────────────────────────────

/**
 * Detect narration — when the LLM outputs prose instead of a JSON tool call.
 * Returns true if the content looks like natural language explanation rather
 * than a JSON object. This is used by the anti-narration system to redirect
 * without burning the correction budget.
 */
export function isNarration(content: string): boolean {
    const trimmed = content.trim()
    // If it starts with '{' or '[', it's probably structured
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false
    // If it contains a code block with JSON, probably structured
    if (/```(?:json)?\s*\n?\s*\{/.test(trimmed)) return false
    // If it contains XML tool blocks, not narration
    if (/<(read_file|write_to_file|execute_command|search_files|list_files|attempt_completion|replace_in_file)>/i.test(trimmed)) return false
    // If it has [TOOL_CALL] markers, not narration
    if (/\[TOOL_CALL\]/i.test(trimmed)) return false
    // Otherwise, if it's more than 50 chars of pure text, it's narration
    return trimmed.length > 50
}
