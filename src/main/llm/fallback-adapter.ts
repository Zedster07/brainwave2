/**
 * Fallback LLM Adapter — Provider failover wrapper
 *
 * Wraps a primary and fallback provider. If the primary fails,
 * automatically retries with the fallback. Only throws if both fail.
 *
 * Vision-aware: when a request includes images and the assigned model
 * doesn't support vision, automatically switches to a known vision-capable
 * model instead of failing with "No endpoints found" errors.
 */
import type { LLMAdapter, LLMRequest, LLMResponse } from './types'

/**
 * Vision-capable model to auto-switch to when the assigned model
 * doesn't support image input. Fast, cheap, excellent vision.
 */
const VISION_FALLBACK_MODEL = 'google/gemini-2.5-flash'

/**
 * Models known to support vision/image input on OpenRouter.
 * If the assigned model is in this set, we send images directly.
 * Otherwise, we swap to VISION_FALLBACK_MODEL for that request.
 */
const VISION_CAPABLE_MODELS = new Set([
  // Google
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'google/gemini-2.0-flash-001',
  // OpenAI
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'openai/gpt-4.1-nano',
  // Anthropic
  'anthropic/claude-sonnet-4',
  'anthropic/claude-opus-4',
  // Qwen Vision
  'qwen/qwen-2.5-vl-72b-instruct',
  'qwen/qwen2.5-vl-32b-instruct',
])

/** Check if a model is known to support vision input */
function isVisionCapable(model: string): boolean {
  return VISION_CAPABLE_MODELS.has(model)
}

/** Detect "no vision support" errors from provider responses */
function isVisionUnsupportedError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return msg.includes('no endpoints found') && msg.includes('image') ||
    msg.includes('does not support image') ||
    msg.includes('vision') && msg.includes('not supported')
}

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
    const hasImages = request.images && request.images.length > 0

    // Vision guard: if request has images and model isn't vision-capable,
    // proactively swap to a vision model instead of failing
    if (hasImages && !isVisionCapable(this.model)) {
      console.log(
        `[LLM] Model "${this.model}" is not vision-capable — auto-switching to "${VISION_FALLBACK_MODEL}" for this request`
      )
      const visionReq = { ...request, model: VISION_FALLBACK_MODEL }
      try {
        return await this.primary.complete(visionReq)
      } catch (visionError) {
        // If even the vision fallback fails, strip images and try original model
        console.warn(
          `[LLM] Vision fallback "${VISION_FALLBACK_MODEL}" also failed, retrying "${this.model}" without images`,
          (visionError as Error).message
        )
        const noImageReq = { ...request, model: this.model, images: undefined }
        return await this.primary.complete(noImageReq)
      }
    }

    const req = { ...request, model: this.model }

    try {
      return await this.primary.complete(req)
    } catch (primaryError) {
      // If primary failed due to vision incompatibility, retry with vision model
      if (hasImages && isVisionUnsupportedError(primaryError as Error)) {
        console.warn(
          `[LLM] "${this.model}" rejected images — retrying with "${VISION_FALLBACK_MODEL}"`,
          (primaryError as Error).message
        )
        try {
          return await this.primary.complete({ ...request, model: VISION_FALLBACK_MODEL })
        } catch { /* fall through to normal fallback */ }
      }

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
