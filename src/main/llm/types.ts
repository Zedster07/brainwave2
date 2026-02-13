/**
 * LLM Adapter — Provider-agnostic interface for language model access
 *
 * Supports OpenRouter (200+ models), Replicate (open-source/specialist),
 * and Ollama (local LLMs — fully offline, no API key needed).
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

export type ModelMode = 'beast' | 'normal' | 'economy' | 'local'

export interface AgentModelConfig {
  provider: 'openrouter' | 'replicate' | 'ollama'
  model: string
  temperature?: number
  maxTokens?: number
}

// ─── Beast Mode: Maximum quality, cost no object ────────────
export const BEAST_MODE_MODELS: Record<string, AgentModelConfig> = {
  orchestrator: { provider: 'openrouter', model: 'anthropic/claude-opus-4.5', temperature: 0.3, maxTokens: 8192 },
  planner:      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', temperature: 0.4, maxTokens: 8192 },
  researcher:   { provider: 'openrouter', model: 'google/gemini-2.5-pro', temperature: 0.5 },
  coder:        { provider: 'openrouter', model: 'anthropic/claude-opus-4.5', temperature: 0.2, maxTokens: 8192 },
  writer:       { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', temperature: 0.7 },
  analyst:      { provider: 'openrouter', model: 'google/gemini-2.5-pro', temperature: 0.3 },
  critic:       { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', temperature: 0.2 },
  reviewer:     { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', temperature: 0.2, maxTokens: 4096 },
  reflection:   { provider: 'openrouter', model: 'google/gemini-2.5-pro', temperature: 0.4, maxTokens: 4096 },
  executor:     { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', temperature: 0.1 },
}

// ─── Normal Mode: Balanced quality & cost ───────────────────
export const NORMAL_MODE_MODELS: Record<string, AgentModelConfig> = {
  orchestrator: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', temperature: 0.3, maxTokens: 8192 },
  planner:      { provider: 'openrouter', model: 'google/gemini-2.5-pro', temperature: 0.4, maxTokens: 8192 },
  researcher:   { provider: 'openrouter', model: 'google/gemini-2.5-flash', temperature: 0.5 },
  coder:        { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', temperature: 0.2, maxTokens: 8192 },
  writer:       { provider: 'openrouter', model: 'anthropic/claude-3.5-haiku', temperature: 0.7 },
  analyst:      { provider: 'openrouter', model: 'google/gemini-2.5-flash', temperature: 0.3 },
  critic:       { provider: 'openrouter', model: 'anthropic/claude-3.5-haiku', temperature: 0.2 },
  reviewer:     { provider: 'openrouter', model: 'anthropic/claude-3.5-haiku', temperature: 0.2, maxTokens: 4096 },
  reflection:   { provider: 'openrouter', model: 'google/gemini-2.5-flash', temperature: 0.4, maxTokens: 4096 },
  executor:     { provider: 'openrouter', model: 'openai/gpt-4.1-mini', temperature: 0.1 },
}

// ─── Economy Mode: Maximum savings, minimum viable quality ──
// All models verified to support response_format + tool calling on OpenRouter
export const ECONOMY_MODE_MODELS: Record<string, AgentModelConfig> = {
  orchestrator: { provider: 'openrouter', model: 'google/gemini-2.5-flash', temperature: 0.3, maxTokens: 8192 },
  planner:      { provider: 'openrouter', model: 'deepseek/deepseek-chat', temperature: 0.4, maxTokens: 8192 },
  researcher:   { provider: 'openrouter', model: 'deepseek/deepseek-chat', temperature: 0.5 },
  coder:        { provider: 'openrouter', model: 'qwen/qwen3-coder', temperature: 0.2, maxTokens: 8192 },
  writer:       { provider: 'openrouter', model: 'deepseek/deepseek-chat', temperature: 0.7 },
  analyst:      { provider: 'openrouter', model: 'deepseek/deepseek-chat', temperature: 0.3 },
  critic:       { provider: 'openrouter', model: 'openai/gpt-4.1-mini', temperature: 0.2 },
  reviewer:     { provider: 'openrouter', model: 'openai/gpt-4.1-mini', temperature: 0.2, maxTokens: 4096 },
  reflection:   { provider: 'openrouter', model: 'openai/gpt-4.1-mini', temperature: 0.4, maxTokens: 4096 },
  executor:     { provider: 'openrouter', model: 'openai/gpt-4.1-mini', temperature: 0.1 },
}

// ─── Local Mode: Fully offline via Ollama ───────────────────
export const LOCAL_MODE_MODELS: Record<string, AgentModelConfig> = {
  orchestrator: { provider: 'ollama', model: 'llama3.1', temperature: 0.3, maxTokens: 8192 },
  planner:      { provider: 'ollama', model: 'llama3.1', temperature: 0.4, maxTokens: 8192 },
  researcher:   { provider: 'ollama', model: 'llama3.1', temperature: 0.5 },
  coder:        { provider: 'ollama', model: 'qwen2.5-coder', temperature: 0.2, maxTokens: 8192 },
  writer:       { provider: 'ollama', model: 'llama3.1', temperature: 0.7 },
  analyst:      { provider: 'ollama', model: 'llama3.1', temperature: 0.3 },
  critic:       { provider: 'ollama', model: 'llama3.1', temperature: 0.2 },
  reviewer:     { provider: 'ollama', model: 'llama3.1', temperature: 0.2, maxTokens: 4096 },
  reflection:   { provider: 'ollama', model: 'llama3.1', temperature: 0.4, maxTokens: 4096 },
  executor:     { provider: 'ollama', model: 'llama3.1', temperature: 0.1 },
}

// ─── Preset Map ─────────────────────────────────────────────
export const MODEL_MODE_PRESETS: Record<ModelMode, Record<string, AgentModelConfig>> = {
  beast: BEAST_MODE_MODELS,
  normal: NORMAL_MODE_MODELS,
  economy: ECONOMY_MODE_MODELS,
  local: LOCAL_MODE_MODELS,
}

// Default = Normal mode
export const DEFAULT_AGENT_MODELS: Record<string, AgentModelConfig> = { ...NORMAL_MODE_MODELS }
