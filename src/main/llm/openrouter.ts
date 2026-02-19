/**
 * OpenRouter Provider — 200+ models via OpenAI-compatible API
 *
 * Uses the official OpenAI SDK with baseURL override.
 * Supports completions, streaming, embeddings, and prompt caching.
 * For models that support prompt caching (Claude, MiniMax), cache_control
 * markers are added to system messages via OpenRouter's pass-through.
 */
import OpenAI from 'openai'
import { net } from 'electron'
import type { LLMAdapter, LLMConfig, LLMRequest, LLMResponse } from './types'
import { getModelCapabilities } from './types'
import { withRetry, getCircuitBreaker } from './retry'

export class OpenRouterProvider implements LLMAdapter {
  readonly provider = 'openrouter'
  private client: OpenAI
  private defaultModel: string
  private apiKey: string

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
    this.apiKey = config.apiKey
  }

  /**
   * Build system messages with optional prompt caching markers.
   * For cacheable models, system content is wrapped in a content array with cache_control.
   * OpenRouter transparently forwards cache_control to supported providers (Anthropic, MiniMax).
   */
  private buildSystemMessages(system: string, context: string | undefined, model: string): OpenAI.Chat.ChatCompletionMessageParam[] {
    const caps = getModelCapabilities(model)
    const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = []

    if (caps.supportsPromptCaching) {
      // Use content array format with cache_control for cacheable models
      // OpenRouter passes cache_control through to the underlying provider
      const systemContent: any[] = [
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
      ]
      if (context) {
        systemContent.push({
          type: 'text',
          text: `<context>\n${context}\n</context>`,
          cache_control: { type: 'ephemeral' },
        })
      }
      msgs.push({ role: 'system', content: systemContent as any })
    } else {
      msgs.push({ role: 'system', content: system })
      if (context) {
        msgs.push({ role: 'system', content: `<context>\n${context}\n</context>` })
      }
    }

    return msgs
  }

  /**
   * Extract cache metrics from OpenRouter response if available.
   * Anthropic models via OpenRouter include cache_creation_input_tokens
   * and cache_read_input_tokens in the usage object.
   */
  private extractCacheMetrics(usage: any): LLMResponse['cacheMetrics'] {
    if (!usage) return undefined
    const creation = usage.cache_creation_input_tokens ?? usage.prompt_tokens_details?.cached_tokens_creation ?? 0
    const read = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
    if (creation > 0 || read > 0) {
      return { cacheCreationInputTokens: creation, cacheReadInputTokens: read }
    }
    return undefined
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const cb = getCircuitBreaker('openrouter')
    if (!cb.canExecute()) {
      throw new Error('OpenRouter circuit breaker is OPEN — provider temporarily unavailable')
    }

    const model = request.model ?? this.defaultModel

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      ...this.buildSystemMessages(request.system, request.context, model),
    ]

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
      console.log(`[OpenRouter] → ${model} | msgs=${messages.length} | format=${request.responseFormat ?? 'text'} | temp=${request.temperature ?? 0.7} | maxTokens=${request.maxTokens ?? 'auto'}${request.images?.length ? ` | images=${request.images.length}` : ''}`)

      const response = await withRetry(
        () => this.client.chat.completions.create({
          model,
          messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens,
          response_format:
            request.responseFormat === 'json' ? { type: 'json_object' } : undefined,
        }, { signal: request.signal }),
        { maxAttempts: 3 },
        `OpenRouter ${model}`
      )

      cb.recordSuccess()
      const choice = response.choices?.[0]
      if (!choice?.message) {
        console.error(
          `[OpenRouter] Empty/malformed response from ${model} — ` +
          `choices=${JSON.stringify(response.choices)}, id=${response.id}`,
        )
        throw new Error(
          `Model ${model} returned an empty response (no choices). ` +
          `This may indicate a rate limit, content filter, or model error.`,
        )
      }

      // Extract cost from OpenRouter's usage extension (total_cost field)
      const apiCost: number | undefined = (response.usage as any)?.total_cost ?? undefined

      console.log(`[OpenRouter] ← ${model} | finish=${choice.finish_reason} | tokens=${response.usage?.prompt_tokens ?? 0}+${response.usage?.completion_tokens ?? 0}${apiCost != null ? ` | cost=$${apiCost.toFixed(6)}` : ''} | response=${(choice.message.content ?? '').slice(0, 150)}...`)

      const cacheMetrics = this.extractCacheMetrics(response.usage)
      if (cacheMetrics) {
        console.log(`[OpenRouter] Cache: created=${cacheMetrics.cacheCreationInputTokens} read=${cacheMetrics.cacheReadInputTokens} (${cacheMetrics.cacheReadInputTokens > 0 ? 'HIT' : 'MISS'})`)
      }

      return {
        content: choice.message.content ?? '',
        model: response.model,
        tokensIn: response.usage?.prompt_tokens ?? 0,
        tokensOut: response.usage?.completion_tokens ?? 0,
        finishReason: choice.finish_reason ?? 'unknown',
        cacheMetrics,
        cost: apiCost,
      }
    } catch (err) {
      cb.recordFailure()
      throw err
    }
  }

  async *stream(request: LLMRequest): AsyncIterable<string> {
    const model = request.model ?? this.defaultModel

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      ...this.buildSystemMessages(request.system, request.context, model),
    ]

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
    }, { signal: request.signal })

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
      // Guard against unexpected response shapes from OpenRouter
      const embedding = response?.data?.[0]?.embedding
      if (!embedding || !Array.isArray(embedding)) {
        const preview = JSON.stringify(response?.data?.slice?.(0, 1) ?? null) ?? ''
        throw new Error(`OpenRouter embedding response malformed: data=${preview.slice(0, 200)}`)
      }
      return new Float32Array(embedding)
    } catch (err) {
      cb.recordFailure()
      throw err
    }
  }

  /**
   * Fetch current API key balance / usage from OpenRouter.
   * Calls GET /auth/key to retrieve credit usage and limits.
   */
  async getBalance(): Promise<{ usage: number; limit: number | null; isFreeTier: boolean; rateLimit?: { requests: number; interval: string } }> {
    return new Promise((resolve, reject) => {
      const request = net.request({
        method: 'GET',
        url: 'https://openrouter.ai/api/v1/auth/key',
      })
      request.setHeader('Authorization', `Bearer ${this.apiKey}`)
      request.setHeader('Content-Type', 'application/json')

      let body = ''
      request.on('response', (response) => {
        response.on('data', (chunk) => { body += chunk.toString() })
        response.on('end', () => {
          try {
            const json = JSON.parse(body)
            const data = json.data ?? json
            resolve({
              usage: data.usage ?? 0,
              limit: data.limit ?? null,
              isFreeTier: data.is_free_tier ?? false,
              rateLimit: data.rate_limit,
            })
          } catch (err) {
            reject(new Error(`Failed to parse OpenRouter balance response: ${body.slice(0, 200)}`))
          }
        })
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end()
    })
  }
}
