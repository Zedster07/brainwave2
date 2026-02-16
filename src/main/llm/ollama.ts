/**
 * Ollama Provider — Local LLM via Ollama's OpenAI-compatible API
 *
 * Runs against localhost (default http://localhost:11434).
 * Supports completions, streaming, and embeddings.
 * No API key required — just a running Ollama instance.
 */
import OpenAI from 'openai'
import type { LLMAdapter, LLMConfig, LLMRequest, LLMResponse } from './types'
import { withRetry, getCircuitBreaker } from './retry'

const DEFAULT_OLLAMA_HOST = 'http://localhost:11434'
const DEFAULT_OLLAMA_MODEL = 'llama3.1'
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text'

export class OllamaProvider implements LLMAdapter {
  readonly provider = 'ollama'
  private client: OpenAI
  private defaultModel: string
  private embeddingModel: string
  private host: string

  constructor(config: LLMConfig) {
    this.host = config.apiKey || DEFAULT_OLLAMA_HOST // apiKey field reused for host URL
    this.defaultModel = config.defaultModel ?? DEFAULT_OLLAMA_MODEL
    this.embeddingModel = DEFAULT_EMBEDDING_MODEL

    // Ollama exposes an OpenAI-compatible API at /v1
    this.client = new OpenAI({
      apiKey: 'ollama', // Ollama doesn't need a real key but OpenAI SDK requires one
      baseURL: `${this.host}/v1`,
    })
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const cb = getCircuitBreaker('ollama')
    if (!cb.canExecute()) {
      throw new Error('Ollama circuit breaker is OPEN — provider temporarily unavailable')
    }

    const model = request.model ?? this.defaultModel

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: request.system },
    ]

    if (request.context) {
      messages.push({
        role: 'system',
        content: `<context>\n${request.context}\n</context>`,
      })
    }

    // Multi-turn conversation: use full message history if provided
    if (request.messages && request.messages.length > 0) {
      for (const msg of request.messages) {
        messages.push({ role: msg.role, content: msg.content })
      }
    } else if (request.images && request.images.length > 0) {
      // Build user message — multimodal content array if images are present
      const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [
        { type: 'text', text: request.user },
        ...request.images.map((img) => ({
          type: 'image_url' as const,
          image_url: {
            url: `data:${img.mimeType};base64,${img.data}`,
            detail: 'auto' as const,
          },
        })),
      ]
      messages.push({ role: 'user', content: contentParts })
    } else {
      messages.push({ role: 'user', content: request.user })
    }

    try {
      const response = await withRetry(
        () =>
          this.client.chat.completions.create({
            model,
            messages,
            temperature: request.temperature ?? 0.7,
            max_tokens: request.maxTokens,
            response_format:
              request.responseFormat === 'json' ? { type: 'json_object' } : undefined,
          }),
        { maxAttempts: 2 }, // Local = fewer retries needed
        `Ollama ${model}`
      )

      cb.recordSuccess()
      const choice = response.choices[0]
      return {
        content: choice.message.content ?? '',
        model: response.model,
        tokensIn: response.usage?.prompt_tokens ?? 0,
        tokensOut: response.usage?.completion_tokens ?? 0,
        finishReason: choice.finish_reason ?? 'unknown',
      }
    } catch (err) {
      cb.recordFailure()
      throw err
    }
  }

  async *stream(request: LLMRequest): AsyncIterable<string> {
    const model = request.model ?? this.defaultModel

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: request.system },
    ]

    if (request.context) {
      messages.push({
        role: 'system',
        content: `<context>\n${request.context}\n</context>`,
      })
    }

    // Multi-turn conversation: use full message history if provided
    if (request.messages && request.messages.length > 0) {
      for (const msg of request.messages) {
        messages.push({ role: msg.role, content: msg.content })
      }
    } else if (request.images && request.images.length > 0) {
      // Build user message — multimodal content array if images are present
      const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [
        { type: 'text', text: request.user },
        ...request.images.map((img) => ({
          type: 'image_url' as const,
          image_url: {
            url: `data:${img.mimeType};base64,${img.data}`,
            detail: 'auto' as const,
          },
        })),
      ]
      messages.push({ role: 'user', content: contentParts })
    } else {
      messages.push({ role: 'user', content: request.user })
    }

    const stream = await this.client.chat.completions.create({
      model,
      messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens,
      stream: true,
    })

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) yield delta
    }
  }

  async embeddings(text: string): Promise<Float32Array> {
    const cb = getCircuitBreaker('ollama')
    if (!cb.canExecute()) {
      throw new Error('Ollama circuit breaker is OPEN — provider temporarily unavailable')
    }

    try {
      const response = await withRetry(
        () =>
          this.client.embeddings.create({
            model: this.embeddingModel,
            input: text,
          }),
        { maxAttempts: 2 },
        'Ollama embeddings'
      )
      cb.recordSuccess()
      return new Float32Array(response.data[0].embedding)
    } catch (err) {
      cb.recordFailure()
      throw err
    }
  }

  /** Check if Ollama is reachable */
  static async healthCheck(host: string = DEFAULT_OLLAMA_HOST): Promise<boolean> {
    try {
      const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) })
      return response.ok
    } catch {
      return false
    }
  }

  /** List available models from the Ollama instance */
  static async listModels(
    host: string = DEFAULT_OLLAMA_HOST
  ): Promise<Array<{ name: string; size: number; modified: string }>> {
    try {
      const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) return []
      const data = (await response.json()) as {
        models: Array<{ name: string; size: number; modified_at: string }>
      }
      return (data.models ?? []).map((m) => ({
        name: m.name,
        size: m.size,
        modified: m.modified_at,
      }))
    } catch {
      return []
    }
  }
}
