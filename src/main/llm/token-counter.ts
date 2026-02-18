/**
 * Token Counter — Context-window-aware token estimation
 *
 * Uses gpt-tokenizer (o200k_base, same as GPT-4o/Claude) to provide:
 *   - Fast, cached token counting for text (hash-keyed for persistence)
 *   - Full prompt size estimation (system + user + context + tool catalog)
 *   - Model context limit lookup
 *   - Budget checking for context compaction triggers
 *   - SQLite persistence: save top 1K entries on quit, reload on startup
 *
 * Inspired by Goose's TokenCounter (tiktoken o200k_base + DashMap cache).
 */
import { encode } from 'gpt-tokenizer/model/gpt-4o'

// ─── Token Cache ──────────────────────────────────────────

const TOKEN_CACHE = new Map<string, number>()
const MAX_CACHE_SIZE = 5_000
const MAX_CACHEABLE_LENGTH = 50_000 // don't cache very large strings — hash would be slow

/**
 * Fast hash for token cache keys. Combines two FNV-1a variants + length
 * for negligible collision probability with up to 5K entries.
 */
function textHash(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0xc9dc5811
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = ((h1 ^ c) * 0x01000193) >>> 0
    h2 = ((h2 ^ c) * 0x19310100) >>> 0
  }
  return `${h1.toString(36)}_${h2.toString(36)}_${text.length}`
}

/**
 * Count tokens in a text string.
 * Uses a hash-keyed LRU-style cache for repeated calls with the same text.
 */
export function countTokens(text: string): number {
  if (!text) return 0

  // For short/medium strings, use cache
  if (text.length <= MAX_CACHEABLE_LENGTH) {
    const hash = textHash(text)
    const cached = TOKEN_CACHE.get(hash)
    if (cached !== undefined) return cached

    const count = encode(text).length

    // Evict oldest entries if cache is full
    if (TOKEN_CACHE.size >= MAX_CACHE_SIZE) {
      const firstKey = TOKEN_CACHE.keys().next().value
      if (firstKey !== undefined) TOKEN_CACHE.delete(firstKey)
    }

    TOKEN_CACHE.set(hash, count)
    return count
  }

  // For very large strings, count directly without caching
  return encode(text).length
}

// ─── Cache Persistence ──────────────────────────────────────

/**
 * Save the current token cache to SQLite.
 * Call this during app shutdown (before-quit) to persist across restarts.
 * Saves up to 1000 most recent entries.
 */
export function saveTokenCacheToDB(): void {
  try {
    // Lazy import to avoid circular dependency
    const { getDatabase } = require('../db/database')
    const db = getDatabase()

    // Check if table exists
    const tableExists = db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='token_cache'`
    )
    if (!tableExists) return

    // Clear existing and insert current cache (transaction for atomicity)
    const entries = Array.from(TOKEN_CACHE.entries())
    // Keep only the 1000 most recent (last 1000 from map iteration order)
    const toSave = entries.slice(-1000)

    db.transaction(() => {
      db.run('DELETE FROM token_cache')
      const stmt = db.prepare('INSERT INTO token_cache (text_hash, token_count) VALUES (?, ?)')
      for (const [hash, count] of toSave) {
        stmt.run(hash, count)
      }
    })

    console.log(`[TokenCache] Saved ${toSave.length} entries to SQLite`)
  } catch (err) {
    console.warn('[TokenCache] Failed to save cache to DB:', err)
  }
}

/**
 * Load persisted token cache from SQLite.
 * Call this during app initialization to warm the cache.
 */
export function loadTokenCacheFromDB(): void {
  try {
    const { getDatabase } = require('../db/database')
    const db = getDatabase()

    const tableExists = db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='token_cache'`
    )
    if (!tableExists) return

    const rows = db.all<{ text_hash: string; token_count: number }>(
      'SELECT text_hash, token_count FROM token_cache'
    )

    let loaded = 0
    for (const row of rows) {
      if (loaded >= MAX_CACHE_SIZE) break
      TOKEN_CACHE.set(row.text_hash, row.token_count)
      loaded++
    }

    console.log(`[TokenCache] Loaded ${loaded} entries from SQLite`)
  } catch (err) {
    console.warn('[TokenCache] Failed to load cache from DB:', err)
  }
}

// ─── Prompt Estimation ──────────────────────────────────────

/** Per-message framing overhead (role header + delimiters) */
const TOKENS_PER_MESSAGE = 4

/** Reply primer tokens */
const REPLY_PRIMER_TOKENS = 3

/**
 * Estimate total tokens for a full LLM request.
 * Accounts for system prompt, user message, context, and message framing.
 */
export function estimateRequestTokens(
  system: string,
  user: string,
  context?: string
): number {
  let tokens = 0

  // System message
  if (system) {
    tokens += countTokens(system) + TOKENS_PER_MESSAGE
  }

  // Context message (injected as second system message)
  if (context) {
    tokens += countTokens(`<context>\n${context}\n</context>`) + TOKENS_PER_MESSAGE
  }

  // User message
  if (user) {
    tokens += countTokens(user) + TOKENS_PER_MESSAGE
  }

  // Reply primer
  tokens += REPLY_PRIMER_TOKENS

  return tokens
}

/**
 * Estimate tokens for a tool catalog section.
 * If the section is already rendered as a string, just count its tokens.
 * Otherwise estimate from tool count.
 */
export function estimateToolCatalogTokens(catalogText: string): number {
  if (!catalogText) return 0
  return countTokens(catalogText)
}

// ─── Model Context Limits ───────────────────────────────────

/**
 * Known context window sizes for models used in Brainwave2.
 * Keys are partial matches — the lookup checks if the model ID contains the key.
 * More specific keys should come first.
 */
const MODEL_CONTEXT_LIMITS: Array<[pattern: string, limit: number]> = [
  // Anthropic
  ['claude-opus-4.5', 200_000],
  ['claude-sonnet-4.5', 200_000],
  ['claude-sonnet-4', 200_000],
  ['claude-3.5-haiku', 200_000],
  ['claude-3-haiku', 200_000],
  ['claude-3-opus', 200_000],
  ['claude-3-sonnet', 200_000],

  // Google
  ['gemini-2.5-pro', 1_048_576],
  ['gemini-2.5-flash', 1_048_576],
  ['gemini-2.0-flash', 1_048_576],
  ['gemini-1.5-pro', 1_048_576],
  ['gemini-1.5-flash', 1_048_576],

  // OpenAI
  ['gpt-5', 400_000],
  ['o3', 200_000],
  ['o1', 200_000],
  ['gpt-4o', 128_000],
  ['gpt-4.1-mini', 1_047_576],
  ['gpt-4.1', 1_047_576],
  ['gpt-4-turbo', 128_000],

  // Qwen
  ['qwen3-coder-next', 256_000],
  ['qwen3-coder', 128_000],
  ['qwen2.5-coder', 128_000],

  // DeepSeek
  ['deepseek-chat', 128_000],
  ['deepseek-coder', 128_000],
  ['deepseek-r1', 128_000],

  // MiniMax
  ['minimax-m2.5', 1_048_576],

  // Ollama / Local
  ['llama3.1', 128_000],
  ['llama3', 8_192],
  ['mistral', 32_000],
  ['mixtral', 32_000],
]

/** Default context limit if model is not in the lookup table */
const DEFAULT_CONTEXT_LIMIT = 128_000

/**
 * Get the context window size for a model.
 * Uses partial matching against known model IDs.
 */
export function getContextLimit(model: string): number {
  if (!model) return DEFAULT_CONTEXT_LIMIT

  const lower = model.toLowerCase()
  for (const [pattern, limit] of MODEL_CONTEXT_LIMITS) {
    if (lower.includes(pattern.toLowerCase())) {
      return limit
    }
  }

  return DEFAULT_CONTEXT_LIMIT
}

// ─── Budget Checking ──────────────────────────────────────────

/** Default compaction threshold — compact when context is this % full */
export const DEFAULT_COMPACTION_THRESHOLD = 0.80

/**
 * Proactive compaction threshold — strip thinking blocks & compact
 * at 60% capacity, well before the hard trim kicks in.
 */
export const PROACTIVE_COMPACTION_THRESHOLD = 0.60

/**
 * Hard cap on input budget regardless of model context window.
 * Even 1M-context models (M2.5, Gemini) should not send 1M of context —
 * it's slow, expensive, and degrades quality.  200K covers any practical
 * coding task while keeping latency and cost in check.
 */
export const MAX_INPUT_BUDGET = 200_000

/**
 * Extra tokens reserved when the model supports extended thinking.
 * Thinking tokens are output tokens but the model's latent reasoning
 * benefits from headroom.  We add this on top of OUTPUT_RESERVE_TOKENS
 * so the model has room for deep reasoning without hitting the ceiling.
 */
export const REASONING_RESERVE_TOKENS = 16_000

/** Reserve this many tokens for the model's response */
const OUTPUT_RESERVE_TOKENS = 4_096

export interface TokenBudget {
  /** Total context window for the model */
  contextLimit: number
  /** Tokens reserved for output */
  outputReserve: number
  /** Available tokens for input (contextLimit - outputReserve) */
  inputBudget: number
  /** Current estimated input tokens */
  currentUsage: number
  /** Usage ratio (0.0 to 1.0) */
  usageRatio: number
  /** Whether compaction should be triggered */
  shouldCompact: boolean
  /** Tokens remaining before compaction threshold */
  tokensRemaining: number
}

/**
 * Calculate the token budget for the current prompt state.
 * Returns a budget object with compaction recommendation.
 */
export function calculateBudget(
  model: string,
  currentTokens: number,
  compactionThreshold = DEFAULT_COMPACTION_THRESHOLD
): TokenBudget {
  const contextLimit = getContextLimit(model)
  const outputReserve = Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(contextLimit * 0.1))
  const inputBudget = contextLimit - outputReserve
  const usageRatio = currentTokens / inputBudget
  const thresholdTokens = Math.floor(inputBudget * compactionThreshold)
  const shouldCompact = currentTokens > thresholdTokens

  return {
    contextLimit,
    outputReserve,
    inputBudget,
    currentUsage: currentTokens,
    usageRatio: Math.min(usageRatio, 1.0),
    shouldCompact,
    tokensRemaining: Math.max(0, thresholdTokens - currentTokens),
  }
}

/**
 * Quick check: should we compact before the next request?
 */
export function shouldCompactContext(
  model: string,
  currentTokens: number,
  threshold = DEFAULT_COMPACTION_THRESHOLD
): boolean {
  return calculateBudget(model, currentTokens, threshold).shouldCompact
}

// ─── Utilities ──────────────────────────────────────────────

/**
 * Format a token count for human display.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(2)}M`
}

/**
 * Clear the token cache. Useful for testing or memory pressure.
 */
export function clearTokenCache(): void {
  TOKEN_CACHE.clear()
}
