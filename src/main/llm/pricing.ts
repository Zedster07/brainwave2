/**
 * Model Pricing — Cost calculation for LLM API usage
 *
 * Prices are per 1M tokens (input/output) sourced from OpenRouter pricing.
 * Updated: July 2025. Prices change — update periodically.
 */

// ─── Pricing Table ──────────────────────────────────────────

interface ModelPricing {
  inputPer1M: number   // USD per 1M input tokens
  outputPer1M: number  // USD per 1M output tokens
}

/**
 * Pricing data for models used in Brainwave2.
 * Keys are partial model ID matches (checked in order, first match wins).
 */
const MODEL_PRICES: Array<[pattern: string, pricing: ModelPricing]> = [
  // Anthropic
  ['claude-opus-4.5',     { inputPer1M: 15.00, outputPer1M: 75.00 }],
  ['claude-sonnet-4.5',   { inputPer1M: 5.00,  outputPer1M: 25.00 }],
  ['claude-sonnet-4',     { inputPer1M: 3.00,  outputPer1M: 15.00 }],
  ['claude-3.5-haiku',    { inputPer1M: 0.80,  outputPer1M: 4.00 }],
  ['claude-3-haiku',      { inputPer1M: 0.25,  outputPer1M: 1.25 }],
  ['claude-3-opus',       { inputPer1M: 15.00, outputPer1M: 75.00 }],
  ['claude-3-sonnet',     { inputPer1M: 3.00,  outputPer1M: 15.00 }],

  // Google
  ['gemini-2.5-pro',      { inputPer1M: 1.25,  outputPer1M: 10.00 }],
  ['gemini-2.5-flash',    { inputPer1M: 0.15,  outputPer1M: 0.60 }],
  ['gemini-2.0-flash',    { inputPer1M: 0.10,  outputPer1M: 0.40 }],
  ['gemini-1.5-pro',      { inputPer1M: 1.25,  outputPer1M: 5.00 }],
  ['gemini-1.5-flash',    { inputPer1M: 0.075, outputPer1M: 0.30 }],

  // OpenAI
  ['gpt-5',               { inputPer1M: 10.00, outputPer1M: 30.00 }],
  ['o3',                   { inputPer1M: 10.00, outputPer1M: 40.00 }],
  ['o1',                   { inputPer1M: 15.00, outputPer1M: 60.00 }],
  ['gpt-4o-mini',          { inputPer1M: 0.15,  outputPer1M: 0.60 }],
  ['gpt-4o',               { inputPer1M: 2.50,  outputPer1M: 10.00 }],
  ['gpt-4.1-nano',         { inputPer1M: 0.10,  outputPer1M: 0.40 }],
  ['gpt-4.1-mini',         { inputPer1M: 0.40,  outputPer1M: 1.60 }],
  ['gpt-4.1',              { inputPer1M: 2.00,  outputPer1M: 8.00 }],
  ['gpt-4-turbo',          { inputPer1M: 10.00, outputPer1M: 30.00 }],

  // Qwen
  ['qwen3-coder-next',    { inputPer1M: 0.20,  outputPer1M: 0.60 }],
  ['qwen3-coder',         { inputPer1M: 0.20,  outputPer1M: 0.60 }],
  ['qwen2.5-coder',       { inputPer1M: 0.15,  outputPer1M: 0.60 }],

  // DeepSeek
  ['deepseek-chat',       { inputPer1M: 0.14,  outputPer1M: 0.28 }],
  ['deepseek-coder',      { inputPer1M: 0.14,  outputPer1M: 0.28 }],
  ['deepseek-r1',         { inputPer1M: 0.55,  outputPer1M: 2.19 }],

  // MiniMax
  ['minimax-m2.5',        { inputPer1M: 0.50,  outputPer1M: 2.00 }],

  // Local / Ollama
  ['llama',               { inputPer1M: 0,     outputPer1M: 0 }],
  ['mistral',             { inputPer1M: 0,     outputPer1M: 0 }],
  ['mixtral',             { inputPer1M: 0,     outputPer1M: 0 }],
  ['qwen',                { inputPer1M: 0,     outputPer1M: 0 }], // local fallback
]

/** Default pricing if model not found */
const DEFAULT_PRICING: ModelPricing = { inputPer1M: 1.00, outputPer1M: 3.00 }

// ─── Cost Calculation ───────────────────────────────────────

/**
 * Look up pricing for a model.
 */
export function getModelPricing(model: string): ModelPricing {
  if (!model) return DEFAULT_PRICING

  const lower = model.toLowerCase()
  for (const [pattern, pricing] of MODEL_PRICES) {
    if (lower.includes(pattern.toLowerCase())) {
      return pricing
    }
  }

  return DEFAULT_PRICING
}

/**
 * Calculate cost in USD for a given model and token usage.
 */
export function calculateCost(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const pricing = getModelPricing(model)
  const inputCost = (tokensIn / 1_000_000) * pricing.inputPer1M
  const outputCost = (tokensOut / 1_000_000) * pricing.outputPer1M
  return inputCost + outputCost
}

/**
 * Format a USD cost for display.
 */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.001) return `$${usd.toFixed(6)}`
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}
