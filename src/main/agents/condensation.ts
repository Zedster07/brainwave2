/**
 * Context Condensation — LLM-powered conversation summarization
 *
 * Extracted from BaseAgent. Handles conversation condensation when the
 * context window approaches its budget limit. Uses a separate LLM call
 * to summarize old messages and replaces them with a concise summary
 * plus folded file context (function/class signatures).
 */
import { LLMFactory } from '../llm'
import { formatTokenCount } from '../llm/token-counter'
import type { ConversationManager } from './conversation-manager'
import type { FileContextTracker } from './file-context-tracker'
import type { FileRegistryEntry } from './context-compactor'
import type { AgentType, EventBus } from './event-bus'
import type { AgentContext } from './types'

/**
 * Perform LLM-powered conversation condensation.
 *
 * Takes old messages from the conversation, sends them to the LLM for
 * summarization, and replaces them with a concise summary + folded file
 * context (function/class signatures). This preserves semantic meaning
 * while freeing token budget for continued work.
 *
 * Falls back to the existing sliding-window trim if LLM call fails.
 */
export async function performCondensation(
    conversation: ConversationManager,
    context: AgentContext,
    agentType: AgentType,
    fileRegistry: Map<string, FileRegistryEntry>,
    fileTracker: FileContextTracker,
    bus: EventBus,
): Promise<void> {
    const { toSummarize } = conversation.getMessagesToCondense(4)
    if (toSummarize.length < 3) return // not enough messages to condense

    // Generate folded file context from tracked files
    const foldedContext = buildFoldedFileContext(fileRegistry)

    // Build summarization prompt from messages to condense
    const messagesText = toSummarize.map(m =>
        `[${m.role.toUpperCase()}]: ${m.content.slice(0, 4000)}` // cap per message to avoid huge prompt
    ).join('\n\n---\n\n')

    const summaryPrompt =
        `Summarize the following conversation between an AI coding assistant and the tools it used. Preserve:\n` +
        `- All file paths mentioned and their relevance\n` +
        `- All code changes made (what was changed and why)\n` +
        `- Current task progress and remaining work\n` +
        `- Any errors encountered and how they were resolved\n` +
        `- Key decisions and their rationale\n\n` +
        `Be concise but thorough. DO NOT call any tools. Return ONLY a text summary.\n\n` +
        `--- CONVERSATION TO SUMMARIZE (${toSummarize.length} messages) ---\n\n${messagesText}`

    try {
        const adapter = LLMFactory.getForAgent(agentType)
        const modelConfig = LLMFactory.getAgentConfig(agentType)

        const response = await adapter.complete({
            model: modelConfig?.model,
            system: 'You are a precise conversation summarizer. Extract key facts, decisions, and progress concisely. Never call tools.',
            user: summaryPrompt,
            temperature: 0.1,
            maxTokens: 2000,
        })

        conversation.applyCondensation(response.content, foldedContext)

        const ctxAfter = conversation.getContextSummary()
        console.log(
            `[${agentType}] LLM condensation complete — ${toSummarize.length} messages summarized, ` +
            `context now at ${ctxAfter.usagePercent}% (${formatTokenCount(ctxAfter.tokensUsed)})`
        )

        bus.emitEvent('agent:acting', {
            agentType,
            taskId: context.taskId,
            action: `🗜️ Context condensed (${toSummarize.length} messages → summary, ${ctxAfter.usagePercent}% used)`,
        })
    } catch (err) {
        console.warn(`[${agentType}] LLM condensation failed, relying on auto-trim fallback:`, err)
        // The existing ConversationManager.trim() will handle overflow on next addMessage
    }
}

/**
 * Build folded file context from the file registry.
 *
 * Extracts function/class/type signatures from cached file contents
 * to preserve structural awareness after condensation. The LLM retains
 * knowledge of the codebase structure without needing full file contents.
 *
 * Regex-based extraction (no tree-sitter dependency).
 */
export function buildFoldedFileContext(fileRegistry: Map<string, FileRegistryEntry>): string {
    if (fileRegistry.size === 0) return ''

    const sections: string[] = []

    for (const [path, entry] of fileRegistry) {
        const lines = entry.content.split('\n')
        // Extract definition lines — function, class, interface, type, export signatures
        const sigLines = lines.filter(line =>
            /^\s*(export\s+)?(default\s+)?(abstract\s+)?(async\s+)?(function|class|interface|type|const|let|enum|def |struct |impl |trait |pub\s+(fn|struct|enum|trait))\s/.test(line)
        ).slice(0, 25) // cap at 25 definitions per file

        if (sigLines.length > 0) {
            const shortPath = path.replace(/\\/g, '/')
            sections.push(`<file-summary path="${shortPath}">\n${sigLines.join('\n')}\n</file-summary>`)
        }
    }

    // Cap total folded context at 30k chars
    return sections.join('\n').slice(0, 30_000)
}
