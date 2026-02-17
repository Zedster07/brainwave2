/**
 * LLM Adapter — Provider-agnostic interface for language model access
 *
 * Supports OpenRouter (200+ models), Replicate (open-source/specialist),
 * Ollama (local LLMs — fully offline, no API key needed),
 * and Anthropic SDK (native tool calling for MiniMax M2.5 / Claude).
 *
 * Each agent can be assigned a different model via per-agent config.
 */

// ─── Core Interfaces ────────────────────────────────────────

/** A single message in a multi-turn conversation (flat string — legacy) */
export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

// ─── Structured Content Blocks (M2.5 / Anthropic Native) ────

/**
 * Content block types for structured message history.
 *
 * M2.5 CARDINAL RULE: The FULL assistant response (including thinking blocks)
 * MUST be preserved in message history for Interleaved Thinking to work.
 * Stripping or summarizing thinking blocks will break multi-turn reasoning.
 */

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  /** Opaque signature for thinking block continuity — DO NOT modify */
  signature?: string
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: 'text'; text: string }>
  is_error?: boolean
}

export interface ImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

/** Union of all content block types */
export type ContentBlock = ThinkingBlock | TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock

/**
 * Structured message for native tool calling protocols (Anthropic SDK format).
 * Content can be a flat string (backward compat) or an array of content blocks.
 */
export interface StructuredMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

/** System message block with optional cache control for prompt caching */
export interface SystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

/** Native tool definition in Anthropic format */
export interface NativeToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/** Native tool definition in OpenAI function calling format */
export interface OpenAIToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

// ─── Extended LLM Request/Response for Native Tool Calling ──

export interface LLMRequest {
  model?: string
  system: string
  user: string
  context?: string
  /**
   * Multi-turn conversation history — if provided, replaces the single
   * `user` field with a full message array. The `user` field is ignored
   * when `messages` is set.
   */
  messages?: ConversationMessage[]
  /**
   * Structured multi-turn conversation for native tool calling.
   * When set, takes precedence over `messages` and `user`.
   * Used with Anthropic SDK / M2.5 native protocol.
   */
  structuredMessages?: StructuredMessage[]
  /**
   * Native tool definitions. When provided, the LLM can respond with
   * tool_use content blocks instead of XML-in-prose tool calls.
   * Format depends on provider (Anthropic vs OpenAI).
   */
  tools?: NativeToolDefinition[]
  /**
   * System message blocks with optional cache control.
   * When set, replaces the flat `system` string for providers that support it.
   */
  systemBlocks?: SystemBlock[]
  temperature?: number  // default 0.7
  maxTokens?: number    // omit = model's max output (unlimited)
  responseFormat?: 'text' | 'json'
  /** Optional images for vision-capable models (base64-encoded) */
  images?: Array<{ data: string; mimeType: string }>
  /** Optional AbortSignal for cancelling in-flight requests */
  signal?: AbortSignal
}

export interface LLMResponse {
  content: string
  model: string
  tokensIn: number
  tokensOut: number
  finishReason: string
  /**
   * Structured content blocks from the assistant response.
   * Present when native tool calling is used (Anthropic SDK / M2.5).
   * Contains thinking blocks, text blocks, and tool_use blocks.
   */
  contentBlocks?: ContentBlock[]
  /**
   * Token usage breakdown including cache metrics.
   * Only available from providers that support prompt caching.
   */
  cacheMetrics?: {
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
  }
}

export interface LLMAdapter {
  readonly provider: string
  complete(request: LLMRequest): Promise<LLMResponse>
  stream(request: LLMRequest): AsyncIterable<string>
  /**
   * Stream with structured content blocks (for native tool calling).
   * Returns an async iterable of stream events rather than plain text chunks.
   * Falls back to stream() if not implemented.
   */
  streamStructured?(request: LLMRequest): AsyncIterable<StreamEvent>
  embeddings(text: string): Promise<Float32Array>
}

/** Stream event types for structured streaming */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; partialJson: string }
  | { type: 'tool_use_end' }
  | { type: 'content_block_stop' }
  | { type: 'message_done'; response: LLMResponse }

export interface LLMConfig {
  apiKey: string
  defaultModel?: string
  /** Base URL override (for MiniMax direct API, etc.) */
  baseURL?: string
}

// ─── Model Capability Metadata ──────────────────────────────

export interface ModelCapabilities {
  supportsNativeTools: boolean
  supportsThinking: boolean
  supportsVision: boolean
  supportsPromptCaching: boolean
  /** 'anthropic' = Anthropic SDK format, 'openai' = OpenAI function calling */
  toolFormat: 'anthropic' | 'openai' | 'xml-only'
  contextWindow: number
  maxOutput: number
}

/**
 * Get capabilities for a known model. Used to decide whether to use
 * native tool calling, thinking preservation, prompt caching, etc.
 */
export function getModelCapabilities(modelId: string): ModelCapabilities {
  const id = modelId.toLowerCase()

  // MiniMax M2.5 — flagship for native tool calling
  if (id.includes('minimax') && id.includes('m2')) {
    return {
      supportsNativeTools: true,
      supportsThinking: true,
      supportsVision: false,
      supportsPromptCaching: true,
      toolFormat: 'anthropic',
      contextWindow: 204_800,
      maxOutput: 131_072,
    }
  }

  // Anthropic Claude models
  if (id.includes('claude')) {
    return {
      supportsNativeTools: true,
      supportsThinking: id.includes('opus') || id.includes('sonnet'),
      supportsVision: true,
      supportsPromptCaching: true,
      toolFormat: 'anthropic',
      contextWindow: 200_000,
      maxOutput: id.includes('opus') ? 32_000 : 16_000,
    }
  }

  // OpenAI / GPT models
  if (id.includes('gpt') || id.includes('openai')) {
    return {
      supportsNativeTools: true,
      supportsThinking: false,
      supportsVision: id.includes('4') || id.includes('gpt-4'),
      supportsPromptCaching: false,
      toolFormat: 'openai',
      contextWindow: id.includes('gpt-4.1') ? 1_000_000 : 128_000,
      maxOutput: 16_384,
    }
  }

  // Google Gemini
  if (id.includes('gemini')) {
    return {
      supportsNativeTools: true,
      supportsThinking: id.includes('pro') || id.includes('2.5'),
      supportsVision: true,
      supportsPromptCaching: false,
      toolFormat: 'openai', // via OpenRouter
      contextWindow: 1_000_000,
      maxOutput: 65_536,
    }
  }

  // DeepSeek
  if (id.includes('deepseek')) {
    return {
      supportsNativeTools: true,
      supportsThinking: id.includes('reasoner'),
      supportsVision: false,
      supportsPromptCaching: false,
      toolFormat: 'openai',
      contextWindow: 128_000,
      maxOutput: 8_192,
    }
  }

  // Default: XML-only for unknown models
  return {
    supportsNativeTools: false,
    supportsThinking: false,
    supportsVision: false,
    supportsPromptCaching: false,
    toolFormat: 'xml-only',
    contextWindow: 128_000,
    maxOutput: 4_096,
  }
}

// ─── Content Block Helpers ──────────────────────────────────

/** Extract plain text from content blocks (ignoring thinking/tool blocks) */
export function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
}

/** Extract tool_use blocks from content blocks */
export function extractToolUseBlocks(blocks: ContentBlock[]): ToolUseBlock[] {
  return blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')
}

/** Extract thinking blocks from content blocks */
export function extractThinkingBlocks(blocks: ContentBlock[]): ThinkingBlock[] {
  return blocks.filter((b): b is ThinkingBlock => b.type === 'thinking')
}

/** Convert flat string content to a single TextBlock array */
export function textToBlocks(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** Convert structured content blocks to a flat string (for backward compat) */
export function blocksToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return extractTextFromBlocks(content)
}

/** Check if content has any tool_use blocks */
export function hasToolUse(content: ContentBlock[]): boolean {
  return content.some(b => b.type === 'tool_use')
}

/** Create a tool_result block */
export function createToolResult(
  toolUseId: string,
  content: string,
  isError = false,
): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError || undefined,
  }
}

// ─── Per-Agent Model Configuration ──────────────────────────

export type ModelMode = 'beast' | 'normal' | 'economy' | 'local'

export interface AgentModelConfig {
  provider: 'openrouter' | 'replicate' | 'ollama' | 'anthropic'
  model: string
  temperature?: number
  maxTokens?: number
  /**
   * When true, use native tool calling (Anthropic SDK format) instead of XML-in-prose.
   * Automatically determined from model capabilities if not set.
   */
  useNativeTools?: boolean
}

// ─── Beast Mode: Maximum quality, cost no object ────────────
// M2.5 is the beast for tool-heavy agents (best BFCL score), Claude for vision
export const BEAST_MODE_MODELS: Record<string, AgentModelConfig> = {
  orchestrator: { provider: 'openrouter', model: 'minimax/minimax-m2.5', temperature: 1.0, maxTokens: 8192, useNativeTools: true },
  planner:      { provider: 'openrouter', model: 'minimax/minimax-m2.5', temperature: 1.0, maxTokens: 8192, useNativeTools: true },
  researcher:   { provider: 'openrouter', model: 'google/gemini-2.5-pro', temperature: 0.5 },
  coder:        { provider: 'openrouter', model: 'minimax/minimax-m2.5', temperature: 1.0, maxTokens: 8192, useNativeTools: true },
  writer:       { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', temperature: 0.7 },
  analyst:      { provider: 'openrouter', model: 'google/gemini-2.5-pro', temperature: 0.3 },
  critic:       { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', temperature: 0.2 },
  reviewer:     { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', temperature: 0.2, maxTokens: 4096 },
  reflection:   { provider: 'openrouter', model: 'google/gemini-2.5-pro', temperature: 0.4, maxTokens: 4096 },
  executor:     { provider: 'openrouter', model: 'minimax/minimax-m2.5', temperature: 1.0, useNativeTools: true },
}

// ─── Normal Mode: Balanced quality & cost ───────────────────
// M2.5 at $0.30/$1.20 is cost-effective enough for normal mode tool agents
export const NORMAL_MODE_MODELS: Record<string, AgentModelConfig> = {
  orchestrator: { provider: 'openrouter', model: 'minimax/minimax-m2.5', temperature: 1.0, maxTokens: 8192, useNativeTools: true },
  planner:      { provider: 'openrouter', model: 'minimax/minimax-m2.5', temperature: 1.0, maxTokens: 8192, useNativeTools: true },
  researcher:   { provider: 'openrouter', model: 'google/gemini-2.5-flash', temperature: 0.5 },
  coder:        { provider: 'openrouter', model: 'minimax/minimax-m2.5', temperature: 1.0, maxTokens: 8192, useNativeTools: true },
  writer:       { provider: 'openrouter', model: 'anthropic/claude-3.5-haiku', temperature: 0.7 },
  analyst:      { provider: 'openrouter', model: 'google/gemini-2.5-flash', temperature: 0.3 },
  critic:       { provider: 'openrouter', model: 'anthropic/claude-3.5-haiku', temperature: 0.2 },
  reviewer:     { provider: 'openrouter', model: 'anthropic/claude-3.5-haiku', temperature: 0.2, maxTokens: 4096 },
  reflection:   { provider: 'openrouter', model: 'google/gemini-2.5-flash', temperature: 0.4, maxTokens: 4096 },
  executor:     { provider: 'openrouter', model: 'minimax/minimax-m2.5', temperature: 1.0, useNativeTools: true },
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
