/**
 * LLM Adapter — Provider-agnostic interface for language model access
 *
 * Supports OpenRouter (200+ models) and Replicate (open-source/specialist).
 * Each agent can be assigned a different model via per-agent config.
 */

// ─── Core Interfaces ────────────────────────────────────────

export interface LLMRequest {
  model?: string
  system: string
  user: string
  context?: string
  temperature?: number  // default 0.7
  maxTokens?: number    // default 4096
  responseFormat?: 'text' | 'json'
}

export interface LLMResponse {
  content: string
  model: string
  tokensIn: number
  tokensOut: number
  finishReason: string
}

export interface LLMAdapter {
  readonly provider: string
  complete(request: LLMRequest): Promise<LLMResponse>
  stream(request: LLMRequest): AsyncIterable<string>
  embeddings(text: string): Promise<Float32Array>
}

export interface LLMConfig {
  apiKey: string
  defaultModel?: string
}

// ─── Per-Agent Model Configuration ──────────────────────────

export interface AgentModelConfig {
  provider: 'openrouter' | 'replicate'
  model: string
  temperature?: number
  maxTokens?: number
}

export const DEFAULT_AGENT_MODELS: Record<string, AgentModelConfig> = {
  orchestrator: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-20250514',
    temperature: 0.3,
    maxTokens: 8192,
  },
  planner: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-20250514',
    temperature: 0.4,
    maxTokens: 8192,
  },
  researcher: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-20250514',
    temperature: 0.5,
  },
  coder: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-20250514',
    temperature: 0.2,
    maxTokens: 8192,
  },
  writer: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-20250514',
    temperature: 0.7,
  },
  analyst: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-20250514',
    temperature: 0.3,
  },
  critic: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-20250514',
    temperature: 0.2,
  },
  reviewer: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-20250514',
    temperature: 0.2,
    maxTokens: 4096,
  },
  reflection: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-20250514',
    temperature: 0.4,
    maxTokens: 4096,
  },
  executor: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-20250514',
    temperature: 0.1,
  },
}
