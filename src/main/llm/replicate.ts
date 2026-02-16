/**
 * Replicate Provider — Open-source & specialist models
 *
 * Uses the official Replicate SDK.
 * Note: Replicate doesn't natively support embeddings, so we throw if called.
 */
import Replicate from 'replicate'
import type { LLMAdapter, LLMConfig, LLMRequest, LLMResponse } from './types'
import { withRetry, getCircuitBreaker } from './retry'

export class ReplicateProvider implements LLMAdapter {
  readonly provider = 'replicate'
  private client: Replicate
  private defaultModel: string

  constructor(config: LLMConfig) {
    this.client = new Replicate({ auth: config.apiKey })
    this.defaultModel = config.defaultModel ?? 'meta/llama-3-70b-instruct'
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const cb = getCircuitBreaker('replicate')
    if (!cb.canExecute()) {
      throw new Error('Replicate circuit breaker is OPEN — provider temporarily unavailable')
    }

    const model = request.model ?? this.defaultModel

    // Build prompt — multi-turn messages or single user prompt
    let prompt: string
    if (request.messages && request.messages.length > 0) {
      prompt = request.messages
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n')
    } else {
      prompt = request.context
        ? `<context>\n${request.context}\n</context>\n\n${request.user}`
        : request.user
    }

    try {
      const output = await withRetry(
        () => this.client.run(model as `${string}/${string}`, {
          input: {
            system_prompt: request.system,
            prompt,
            temperature: request.temperature ?? 0.7,
            ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          },
        }),
        { maxAttempts: 3 },
        `Replicate ${model}`
      )

      cb.recordSuccess()
      const content = Array.isArray(output) ? output.join('') : String(output)

      return {
        content,
        model,
        tokensIn: 0,
        tokensOut: 0,
        finishReason: 'stop',
      }
    } catch (err) {
      cb.recordFailure()
      throw err
    }
  }

  async *stream(request: LLMRequest): AsyncIterable<string> {
    const model = request.model ?? this.defaultModel

    // Build prompt — multi-turn messages or single user prompt
    let prompt: string
    if (request.messages && request.messages.length > 0) {
      prompt = request.messages
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n')
    } else {
      prompt = request.context
        ? `<context>\n${request.context}\n</context>\n\n${request.user}`
        : request.user
    }

    const stream = this.client.stream(model as `${string}/${string}`, {
      input: {
        system_prompt: request.system,
        prompt,
        temperature: request.temperature ?? 0.7,
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      },
    })

    for await (const event of stream) {
      yield String(event)
    }
  }

  async embeddings(_text: string): Promise<Float32Array> {
    throw new Error(
      'ReplicateProvider does not support embeddings. Use OpenRouterProvider for embeddings.'
    )
  }
}
