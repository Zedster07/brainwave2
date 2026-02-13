/**
 * Fallback LLM Adapter — Provider failover wrapper
 *
 * Wraps a primary and fallback provider. If the primary fails,
 * automatically retries with the fallback. Only throws if both fail.
 */
import type { LLMAdapter, LLMRequest, LLMResponse } from './types'

export class FallbackLLMAdapter implements LLMAdapter {
  readonly provider: string

  constructor(
    private primary: LLMAdapter,
    private fallback: LLMAdapter | null,
    private model: string,
  ) {
    this.provider = fallback
      ? `${primary.provider}→${fallback.provider}`
      : primary.provider
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const req = { ...request, model: this.model }

    try {
      return await this.primary.complete(req)
    } catch (primaryError) {
      if (!this.fallback) throw primaryError

      console.warn(
        `[LLM] ${this.primary.provider} failed for model "${this.model}", trying ${this.fallback.provider}...`,
        (primaryError as Error).message
      )

      try {
        return await this.fallback.complete(req)
      } catch (fallbackError) {
        throw new Error(
          `Both LLM providers failed for model "${this.model}".\n` +
          `  ${this.primary.provider}: ${(primaryError as Error).message}\n` +
          `  ${this.fallback.provider}: ${(fallbackError as Error).message}`
        )
      }
    }
  }

  async *stream(request: LLMRequest): AsyncIterable<string> {
    const req = { ...request, model: this.model }

    try {
      yield* this.primary.stream(req)
      return
    } catch (primaryError) {
      if (!this.fallback) throw primaryError

      console.warn(
        `[LLM] ${this.primary.provider} stream failed for "${this.model}", trying ${this.fallback.provider}...`,
        (primaryError as Error).message
      )

      try {
        yield* this.fallback.stream(req)
      } catch (fallbackError) {
        throw new Error(
          `Both LLM providers failed streaming for model "${this.model}".\n` +
          `  ${this.primary.provider}: ${(primaryError as Error).message}\n` +
          `  ${this.fallback.provider}: ${(fallbackError as Error).message}`
        )
      }
    }
  }

  async embeddings(text: string): Promise<Float32Array> {
    // Embeddings: try primary first (OpenRouter supports it)
    // If it fails, try fallback — but Replicate may not support it
    try {
      return await this.primary.embeddings(text)
    } catch (primaryError) {
      if (!this.fallback) throw primaryError

      try {
        return await this.fallback.embeddings(text)
      } catch {
        // Fallback likely doesn't support embeddings, throw original error
        throw primaryError
      }
    }
  }
}
