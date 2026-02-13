/**
 * OpenRouter Provider — 200+ models via OpenAI-compatible API
 *
 * Uses the official OpenAI SDK with baseURL override.
 * Supports completions, streaming, and embeddings.
 */
import OpenAI from 'openai'
import type { LLMAdapter, LLMConfig, LLMRequest, LLMResponse } from './types'
import { withRetry, getCircuitBreaker } from './retry'

export class OpenRouterProvider implements LLMAdapter {
  readonly provider = 'openrouter'
  private client: OpenAI
  private defaultModel: string

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      timeout: 60_000, // 60s per request — prevents infinite hangs
      defaultHeaders: {
        'HTTP-Referer': 'https://brainwave2.app',
        'X-Title': 'Brainwave 2',
      },
    })
    this.defaultModel = config.defaultModel ?? 'anthropic/claude-sonnet-4-20250514'
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const cb = getCircuitBreaker('openrouter')
    if (!cb.canExecute()) {
      throw new Error('OpenRouter circuit breaker is OPEN — provider temporarily unavailable')
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

    messages.push({ role: 'user', content: request.user })

    try {
      const response = await withRetry(
        () => this.client.chat.completions.create({
          model,
          messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens ?? 4096,
          response_format:
            request.responseFormat === 'json' ? { type: 'json_object' } : undefined,
        }),
        { maxAttempts: 3 },
        `OpenRouter ${model}`
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

    messages.push({ role: 'user', content: request.user })

    const stream = await this.client.chat.completions.create({
      model,
      messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
    })

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) yield delta
    }
  }

  async embeddings(text: string): Promise<Float32Array> {
    const cb = getCircuitBreaker('openrouter')
    if (!cb.canExecute()) {
      throw new Error('OpenRouter circuit breaker is OPEN — provider temporarily unavailable')
    }

    try {
      const response = await withRetry(
        () => this.client.embeddings.create({
          model: 'openai/text-embedding-3-small',
          input: text,
        }),
        { maxAttempts: 3 },
        'OpenRouter embeddings'
      )
      cb.recordSuccess()
      return new Float32Array(response.data[0].embedding)
    } catch (err) {
      cb.recordFailure()
      throw err
    }
  }
}
