/**
 * Replicate Provider — Open-source & specialist models
 *
 * Uses the official Replicate SDK.
 * Note: Replicate doesn't natively support embeddings, so we throw if called.
 */
import Replicate from 'replicate'
import type { LLMAdapter, LLMConfig, LLMRequest, LLMResponse } from './types'

export class ReplicateProvider implements LLMAdapter {
  readonly provider = 'replicate'
  private client: Replicate
  private defaultModel: string

  constructor(config: LLMConfig) {
    this.client = new Replicate({ auth: config.apiKey })
    this.defaultModel = config.defaultModel ?? 'meta/llama-3-70b-instruct'
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model ?? this.defaultModel

    const output = await this.client.run(model as `${string}/${string}`, {
      input: {
        system_prompt: request.system,
        prompt: request.context
          ? `<context>\n${request.context}\n</context>\n\n${request.user}`
          : request.user,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 4096,
      },
    })

    const content = Array.isArray(output) ? output.join('') : String(output)

    return {
      content,
      model,
      tokensIn: 0,  // Replicate doesn't return token counts in basic mode
      tokensOut: 0,
      finishReason: 'stop',
    }
  }

  async *stream(request: LLMRequest): AsyncIterable<string> {
    const model = request.model ?? this.defaultModel

    const stream = this.client.stream(model as `${string}/${string}`, {
      input: {
        system_prompt: request.system,
        prompt: request.context
          ? `<context>\n${request.context}\n</context>\n\n${request.user}`
          : request.user,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 4096,
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
