/**
 * Anthropic SDK Provider — Native tool calling for MiniMax M2.5 & Claude
 *
 * Uses the official @anthropic-ai/sdk with configurable base URL.
 * Primary use: MiniMax M2.5 via their Anthropic-compatible endpoint.
 *
 * Key features:
 * - Native tool calling (tool_use / tool_result content blocks)
 * - Interleaved Thinking preservation (thinking blocks in response)
 * - Prompt caching support (cache_control on system blocks)
 * - Structured streaming with content block events
 *
 * M2.5 CARDINAL RULES (from MiniMax docs):
 * 1. temperature MUST be exactly 1.0 when thinking is enabled
 * 2. Full response content (including thinking) MUST be preserved in history
 * 3. thinking blocks MUST NOT be modified or summarized
 * 4. System prompt goes in top-level `system` param, NOT in messages
 */
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type {
  LLMAdapter,
  LLMConfig,
  LLMRequest,
  LLMResponse,
  ContentBlock,
  StreamEvent,
  StructuredMessage,
  NativeToolDefinition,
  TextBlock,
  ToolResultBlock,
} from './types'
import { withRetry, getCircuitBreaker } from './retry'

// ─── Type mappings from Anthropic SDK → our types ───────────

/** Convert Anthropic SDK content block to our ContentBlock type */
function mapContentBlock(block: Anthropic.ContentBlock): ContentBlock {
  switch (block.type) {
    case 'thinking':
      return {
        type: 'thinking',
        thinking: (block as Anthropic.ThinkingBlock).thinking,
        signature: (block as Anthropic.ThinkingBlock).signature,
      }
    case 'text':
      return {
        type: 'text',
        text: (block as Anthropic.TextBlock).text,
      }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: (block as Anthropic.ToolUseBlock).id,
        name: (block as Anthropic.ToolUseBlock).name,
        input: (block as Anthropic.ToolUseBlock).input as Record<string, unknown>,
      }
    default:
      // Unknown block type — wrap as text
      return {
        type: 'text',
        text: JSON.stringify(block),
      }
  }
}

/** Convert our StructuredMessage to Anthropic SDK message format */
function toAnthropicMessage(
  msg: StructuredMessage,
): Anthropic.MessageParam {
  if (typeof msg.content === 'string') {
    return {
      role: msg.role,
      content: msg.content,
    }
  }

  // Convert our content blocks to Anthropic format
  const content: Anthropic.ContentBlockParam[] = msg.content.map((block): Anthropic.ContentBlockParam => {
    switch (block.type) {
      case 'thinking':
        return {
          type: 'thinking' as const,
          thinking: block.thinking,
          signature: block.signature ?? '',
        }
      case 'text':
        return {
          type: 'text' as const,
          text: block.text,
        }
      case 'tool_use':
        return {
          type: 'tool_use' as const,
          id: block.id,
          name: block.name,
          input: block.input,
        }
      case 'tool_result':
        return {
          type: 'tool_result' as const,
          tool_use_id: block.tool_use_id,
          content: typeof block.content === 'string'
            ? block.content
            : block.content,
          is_error: block.is_error,
        }
      case 'image':
        return {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: block.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: block.source.data,
          },
        }
      default:
        return {
          type: 'text' as const,
          text: JSON.stringify(block),
        }
    }
  })

  return { role: msg.role, content }
}

/** Convert our NativeToolDefinition to Anthropic SDK tool format */
function toAnthropicToolParam(tool: NativeToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
    ...(tool.cache_control ? { cache_control: tool.cache_control } : {}),
  } as Anthropic.Tool
}

// ─── Provider Implementation ────────────────────────────────

export class AnthropicProvider implements LLMAdapter {
  readonly provider = 'anthropic'
  private client: Anthropic
  private openaiClient?: OpenAI
  private defaultModel: string
  private isOpenRouter: boolean

  /** Provider routing for OpenRouter — ensures non-Anthropic models reach the right provider */
  private static readonly OPENROUTER_PROVIDER_PREFS = {
    provider: {
      order: ['minimax', 'fireworks', 'novita', 'atlas-cloud', 'siliconflow'],
      allow_fallbacks: true,
    },
  }

  constructor(config: LLMConfig) {
    this.isOpenRouter = (config.baseURL ?? '').includes('openrouter.ai')

    if (this.isOpenRouter) {
      // OpenRouter's /api/v1/messages endpoint forces routing to the "anthropic"
      // provider, but MiniMax M2.5 isn't served by Anthropic on OpenRouter.
      // We use the OpenAI SDK to call /api/v1/chat/completions instead, which
      // supports provider routing via the `provider` body field.
      this.openaiClient = new OpenAI({
        apiKey: config.apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
        timeout: 120_000,
        defaultHeaders: {
          'HTTP-Referer': 'https://brainwave2.app',
          'X-Title': 'Brainwave 2',
        },
      })
    }

    // Anthropic SDK — used for direct MiniMax API / Anthropic API (non-OpenRouter)
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? 'https://api.minimax.io/anthropic',
      timeout: 120_000,
      defaultHeaders: {
        'X-Title': 'Brainwave 2',
      },
    })
    this.defaultModel = config.defaultModel ?? 'MiniMax-M2.5'
  }

  // ─── OpenRouter Format Conversion (Anthropic ↔ OpenAI) ────

  /**
   * Convert structured messages (Anthropic content blocks) to OpenAI chat format.
   * Handles: thinking → dropped, text → content, tool_use → tool_calls, tool_result → role:tool
   */
  private structuredMessagesToOpenAI(
    structuredMessages: StructuredMessage[],
    systemContent: string,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemContent },
    ]

    for (const msg of structuredMessages) {
      // Simple string content — pass through
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content })
        continue
      }

      if (msg.role === 'assistant') {
        // Extract text → content, tool_use → tool_calls, skip thinking
        const textParts: string[] = []
        const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            })
          }
          // thinking blocks are dropped — OpenAI format doesn't support them in history
        }

        const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textParts.join('') || null,
        }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls
        }
        messages.push(assistantMsg)
      } else {
        // User message — tool_result blocks become role:tool messages
        const toolResults = (msg.content as ContentBlock[]).filter(
          (b): b is ToolResultBlock => b.type === 'tool_result',
        )
        const textBlocks = (msg.content as ContentBlock[]).filter(
          (b): b is TextBlock => b.type === 'text',
        )

        // Tool results → individual tool messages
        for (const tr of toolResults) {
          messages.push({
            role: 'tool' as const,
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === 'string'
              ? tr.content
              : tr.content.map(c => c.text).join(''),
          })
        }

        // Any remaining text → user message
        const userText = textBlocks.map(b => b.text).join('')
        if (userText) {
          messages.push({ role: 'user', content: userText })
        }
      }
    }

    return messages
  }

  /** Convert native tool definitions (Anthropic format) to OpenAI function calling format */
  private nativeToolsToOpenAI(
    tools: NativeToolDefinition[],
  ): OpenAI.Chat.ChatCompletionTool[] {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema as OpenAI.FunctionParameters,
      },
    }))
  }

  /** Convert OpenAI chat completion message to our ContentBlock[] */
  private openAIResponseToBlocks(
    message: OpenAI.Chat.ChatCompletionMessage,
  ): ContentBlock[] {
    const blocks: ContentBlock[] = []

    // Reasoning/thinking content (OpenRouter extension for thinking models)
    const reasoning = (message as Record<string, unknown>).reasoning_content
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      blocks.push({ type: 'thinking', thinking: reasoning })
    }

    // Text content
    if (message.content) {
      blocks.push({ type: 'text', text: message.content })
    }

    // Tool calls → ToolUseBlock
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        let parsedInput: Record<string, unknown> = {}
        try {
          parsedInput = JSON.parse(tc.function.arguments || '{}')
        } catch {
          console.warn(`[Anthropic/OpenRouter] Failed to parse tool args for ${tc.function.name}`)
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parsedInput,
        })
      }
    }

    return blocks
  }

  // ─── OpenRouter Chat Completions Path ─────────────────────

  /**
   * Complete via OpenRouter's /api/v1/chat/completions endpoint.
   * Converts Anthropic content blocks ↔ OpenAI message format.
   * Supports provider routing so MiniMax M2.5 reaches the right provider.
   */
  private async completeViaOpenRouter(request: LLMRequest): Promise<LLMResponse> {
    const cb = getCircuitBreaker('anthropic')
    if (!cb.canExecute()) {
      throw new Error('Anthropic circuit breaker is OPEN — provider temporarily unavailable')
    }

    const model = request.model ?? this.defaultModel
    const systemContent = request.systemBlocks
      ? request.systemBlocks.map(b => b.text).join('\n\n')
      : request.system

    // Build messages in OpenAI format
    const messages = request.structuredMessages?.length
      ? this.structuredMessagesToOpenAI(request.structuredMessages, systemContent)
      : this.legacyRequestToOpenAI(request, systemContent)

    // Build tools in OpenAI format
    const tools = request.tools?.length
      ? this.nativeToolsToOpenAI(request.tools)
      : undefined

    try {
      console.log(
        `[Anthropic/OpenRouter] → ${model} (chat/completions) | msgs=${messages.length} | ` +
        `tools=${tools?.length ?? 0} | temp=${request.temperature ?? 1.0} | ` +
        `maxTokens=${request.maxTokens ?? 8192}`,
      )

      const response = await withRetry(
        () => this.openaiClient!.chat.completions.create({
          model,
          messages,
          tools,
          temperature: request.temperature ?? 1.0,
          max_tokens: request.maxTokens ?? 8192,
          // Provider routing for OpenRouter (extra body field)
          ...AnthropicProvider.OPENROUTER_PROVIDER_PREFS,
        } as Parameters<typeof this.openaiClient!['chat']['completions']['create']>[0]),
        { maxAttempts: 3 },
        `OpenRouter/Anthropic ${model}`,
      )

      cb.recordSuccess()
      const choice = response.choices[0]
      const contentBlocks = this.openAIResponseToBlocks(choice.message)

      const textContent = contentBlocks
        .filter((b): b is TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')

      console.log(
        `[Anthropic/OpenRouter] ← ${model} | finish=${choice.finish_reason} | ` +
        `blocks=${contentBlocks.length} (${contentBlocks.map(b => b.type).join(',')}) | ` +
        `tokens=${response.usage?.prompt_tokens ?? 0}+${response.usage?.completion_tokens ?? 0}`,
      )

      return {
        content: textContent,
        model: response.model,
        tokensIn: response.usage?.prompt_tokens ?? 0,
        tokensOut: response.usage?.completion_tokens ?? 0,
        finishReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : (choice.finish_reason ?? 'unknown'),
        contentBlocks,
      }
    } catch (err) {
      cb.recordFailure()
      throw err
    }
  }

  /** Convert a legacy LLMRequest (no structuredMessages) to OpenAI messages */
  private legacyRequestToOpenAI(
    request: LLMRequest,
    systemContent: string,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemContent },
    ]

    if (request.messages?.length) {
      for (const msg of request.messages) {
        messages.push({ role: msg.role, content: msg.content })
      }
    } else if (request.context) {
      messages.push({
        role: 'user',
        content: `<context>\n${request.context}\n</context>\n\n${request.user}`,
      })
    } else {
      messages.push({ role: 'user', content: request.user })
    }

    return messages
  }

  // ─── OpenRouter Streaming via Chat Completions ────────────

  /**
   * Stream plain text via OpenRouter's chat/completions endpoint.
   */
  private async *streamViaOpenRouter(request: LLMRequest): AsyncIterable<string> {
    const model = request.model ?? this.defaultModel
    const systemContent = request.systemBlocks
      ? request.systemBlocks.map(b => b.text).join('\n\n')
      : request.system

    const messages = request.structuredMessages?.length
      ? this.structuredMessagesToOpenAI(request.structuredMessages, systemContent)
      : this.legacyRequestToOpenAI(request, systemContent)

    const tools = request.tools?.length
      ? this.nativeToolsToOpenAI(request.tools)
      : undefined

    const stream = await this.openaiClient!.chat.completions.create({
      model,
      messages,
      tools,
      temperature: request.temperature ?? 1.0,
      max_tokens: request.maxTokens ?? 8192,
      stream: true,
      ...AnthropicProvider.OPENROUTER_PROVIDER_PREFS,
    } as Parameters<typeof this.openaiClient!['chat']['completions']['create']>[0])

    for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) yield delta
    }
  }

  /**
   * Stream with structured events via OpenRouter's chat/completions endpoint.
   * Converts OpenAI streaming deltas to our StreamEvent types.
   */
  private async *streamStructuredViaOpenRouter(
    request: LLMRequest,
  ): AsyncIterable<StreamEvent> {
    const model = request.model ?? this.defaultModel
    const systemContent = request.systemBlocks
      ? request.systemBlocks.map(b => b.text).join('\n\n')
      : request.system

    const messages = request.structuredMessages?.length
      ? this.structuredMessagesToOpenAI(request.structuredMessages, systemContent)
      : this.legacyRequestToOpenAI(request, systemContent)

    const tools = request.tools?.length
      ? this.nativeToolsToOpenAI(request.tools)
      : undefined

    const stream = await this.openaiClient!.chat.completions.create({
      model,
      messages,
      tools,
      temperature: request.temperature ?? 1.0,
      max_tokens: request.maxTokens ?? 8192,
      stream: true,
      stream_options: { include_usage: true },
      ...AnthropicProvider.OPENROUTER_PROVIDER_PREFS,
    } as Parameters<typeof this.openaiClient!['chat']['completions']['create']>[0])

    const contentBlocks: ContentBlock[] = []
    let totalTokensIn = 0
    let totalTokensOut = 0
    let finishReason = 'unknown'
    // Track active tool calls by index for streaming assembly
    const activeToolCalls = new Map<number, { id: string; name: string; arguments: string }>()

    for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
      const choice = chunk.choices?.[0]

      if (choice?.finish_reason) {
        finishReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason
      }

      if (choice?.delta) {
        const delta = choice.delta

        // Reasoning/thinking content (OpenRouter extension)
        const reasoning = (delta as Record<string, unknown>).reasoning_content
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          yield { type: 'thinking', thinking: reasoning }
        }

        // Text content
        if (delta.content) {
          yield { type: 'text', text: delta.content }
        }

        // Tool calls streaming
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (tc.id && tc.function?.name) {
              // New tool call starting
              activeToolCalls.set(idx, {
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments ?? '',
              })
              yield { type: 'tool_use_start', id: tc.id, name: tc.function.name }
            } else if (tc.function?.arguments) {
              // Argument delta
              const existing = activeToolCalls.get(idx)
              if (existing) {
                existing.arguments += tc.function.arguments
              }
              yield { type: 'tool_use_delta', partialJson: tc.function.arguments }
            }
          }
        }
      }

      // Usage info (from stream_options: { include_usage: true })
      if (chunk.usage) {
        totalTokensIn = chunk.usage.prompt_tokens ?? 0
        totalTokensOut = chunk.usage.completion_tokens ?? 0
      }
    }

    // Finalize tool call blocks
    for (const [, tc] of activeToolCalls) {
      yield { type: 'tool_use_end' }
      yield { type: 'content_block_stop' }
      let parsedInput: Record<string, unknown> = {}
      try {
        parsedInput = JSON.parse(tc.arguments || '{}')
      } catch {
        console.warn(`[Anthropic/OpenRouter] Failed to parse streamed tool args for ${tc.name}`)
      }
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: parsedInput,
      })
    }

    // Build final text content
    const textContent = contentBlocks
      .filter((b): b is TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')

    yield {
      type: 'message_done',
      response: {
        content: textContent,
        model,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        finishReason,
        contentBlocks,
      },
    }
  }

  // ─── Public API Methods ───────────────────────────────────

  /**
   * Complete a request using the Anthropic Messages API.
   * Returns structured content blocks for native tool calling.
   */
  async complete(request: LLMRequest): Promise<LLMResponse> {
    // OpenRouter: use chat/completions endpoint (supports provider routing)
    if (this.isOpenRouter && this.openaiClient) {
      return this.completeViaOpenRouter(request)
    }

    // Direct Anthropic/MiniMax API: use Anthropic SDK
    const cb = getCircuitBreaker('anthropic')
    if (!cb.canExecute()) {
      throw new Error('Anthropic circuit breaker is OPEN — provider temporarily unavailable')
    }

    const model = request.model ?? this.defaultModel
    const isThinkingModel = model.toLowerCase().includes('m2') || model.toLowerCase().includes('claude')

    // Build system parameter
    const system = request.systemBlocks
      ? request.systemBlocks.map(b => ({
          type: 'text' as const,
          text: b.text,
          ...(b.cache_control ? { cache_control: b.cache_control } : {}),
        }))
      : request.system

    // Build messages
    const messages = this.buildMessages(request)

    // Build tools parameter
    const tools = request.tools?.map(toAnthropicToolParam)

    try {
      console.log(
        `[Anthropic] → ${model} | msgs=${messages.length} | tools=${tools?.length ?? 0} | ` +
        `temp=${request.temperature ?? 1.0} | maxTokens=${request.maxTokens ?? 8192}`
      )

      const response = await withRetry(
        () => this.client.messages.create({
          model,
          max_tokens: request.maxTokens ?? 8192,
          system,
          messages,
          tools,
          temperature: isThinkingModel ? 1.0 : (request.temperature ?? 0.7),
          // Enable extended thinking for supported models
          ...(isThinkingModel ? {
            thinking: {
              type: 'enabled' as const,
              budget_tokens: Math.min(
                (request.maxTokens ?? 8192) - 1000,
                16_000, // Default thinking budget
              ),
            },
          } : {}),
        } as Parameters<typeof this.client.messages.create>[0], { signal: request.signal }),
        { maxAttempts: 3 },
        `Anthropic ${model}`
      )

      cb.recordSuccess()

      // Map content blocks to our types
      const contentBlocks = response.content.map(mapContentBlock)

      // Extract plain text for backward compatibility
      const textContent = contentBlocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('')

      console.log(
        `[Anthropic] ← ${model} | finish=${response.stop_reason} | ` +
        `blocks=${contentBlocks.length} (${contentBlocks.map(b => b.type).join(',')}) | ` +
        `tokens=${response.usage.input_tokens}+${response.usage.output_tokens} | ` +
        `cache_create=${(response.usage as unknown as Record<string, number>).cache_creation_input_tokens ?? 0} ` +
        `cache_read=${(response.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0}`
      )

      return {
        content: textContent,
        model: response.model,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        finishReason: response.stop_reason ?? 'unknown',
        contentBlocks,
        cacheMetrics: {
          cacheCreationInputTokens: (response.usage as unknown as Record<string, number>).cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: (response.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0,
        },
      }
    } catch (err) {
      cb.recordFailure()
      throw err
    }
  }

  /**
   * Stream responses as plain text chunks (backward compatibility).
   * For structured streaming with content blocks, use streamStructured().
   */
  async *stream(request: LLMRequest): AsyncIterable<string> {
    // OpenRouter: use chat/completions streaming
    if (this.isOpenRouter && this.openaiClient) {
      yield* this.streamViaOpenRouter(request)
      return
    }

    // Direct Anthropic/MiniMax API: use Anthropic SDK streaming
    const model = request.model ?? this.defaultModel
    const isThinkingModel = model.toLowerCase().includes('m2') || model.toLowerCase().includes('claude')

    const system = request.systemBlocks
      ? request.systemBlocks.map(b => ({
          type: 'text' as const,
          text: b.text,
          ...(b.cache_control ? { cache_control: b.cache_control } : {}),
        }))
      : request.system

    const messages = this.buildMessages(request)
    const tools = request.tools?.map(toAnthropicToolParam)

    const stream = this.client.messages.stream({
      model,
      max_tokens: request.maxTokens ?? 8192,
      system,
      messages,
      tools,
      temperature: isThinkingModel ? 1.0 : (request.temperature ?? 0.7),
      ...(isThinkingModel ? {
        thinking: {
          type: 'enabled' as const,
          budget_tokens: Math.min(
            (request.maxTokens ?? 8192) - 1000,
            16_000,
          ),
        },
      } : {}),
    } as Parameters<typeof this.client.messages.stream>[0], { signal: request.signal })

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta as unknown as Record<string, unknown>
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          yield delta.text
        }
      }
    }
  }

  /**
   * Stream with structured content block events.
   * Provides thinking blocks, tool_use blocks, and text deltas as typed events.
   * This is the preferred method for the native tool calling agent loop.
   */
  async *streamStructured(request: LLMRequest): AsyncIterable<StreamEvent> {
    // OpenRouter: use chat/completions structured streaming
    if (this.isOpenRouter && this.openaiClient) {
      yield* this.streamStructuredViaOpenRouter(request)
      return
    }

    // Direct Anthropic/MiniMax API: use Anthropic SDK structured streaming
    const model = request.model ?? this.defaultModel
    const isThinkingModel = model.toLowerCase().includes('m2') || model.toLowerCase().includes('claude')

    const system = request.systemBlocks
      ? request.systemBlocks.map(b => ({
          type: 'text' as const,
          text: b.text,
          ...(b.cache_control ? { cache_control: b.cache_control } : {}),
        }))
      : request.system

    const messages = this.buildMessages(request)
    const tools = request.tools?.map(toAnthropicToolParam)

    const stream = this.client.messages.stream({
      model,
      max_tokens: request.maxTokens ?? 8192,
      system,
      messages,
      tools,
      temperature: isThinkingModel ? 1.0 : (request.temperature ?? 0.7),
      ...(isThinkingModel ? {
        thinking: {
          type: 'enabled' as const,
          budget_tokens: Math.min(
            (request.maxTokens ?? 8192) - 1000,
            16_000,
          ),
        },
      } : {}),
    } as Parameters<typeof this.client.messages.stream>[0], { signal: request.signal })

    // Accumulate the full response for the final message_done event
    const contentBlocks: ContentBlock[] = []
    let currentBlockType: string | null = null

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block as unknown as Record<string, unknown>
          currentBlockType = block.type as string

          if (block.type === 'thinking') {
            // Thinking block starts — accumulate it
            contentBlocks.push({
              type: 'thinking',
              thinking: '',
              signature: undefined,
            })
            yield { type: 'thinking', thinking: '' }
          } else if (block.type === 'text') {
            contentBlocks.push({ type: 'text', text: '' })
          } else if (block.type === 'tool_use') {
            const toolBlock = block as { type: string; id: string; name: string }
            contentBlocks.push({
              type: 'tool_use',
              id: toolBlock.id,
              name: toolBlock.name,
              input: {},
            })
            yield {
              type: 'tool_use_start',
              id: toolBlock.id,
              name: toolBlock.name,
            }
          }
          break
        }

        case 'content_block_delta': {
          const delta = event.delta as unknown as Record<string, unknown>

          if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            // Accumulate thinking text
            const lastBlock = contentBlocks[contentBlocks.length - 1]
            if (lastBlock?.type === 'thinking') {
              lastBlock.thinking += delta.thinking
            }
            yield { type: 'thinking', thinking: delta.thinking }
          } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            const lastBlock = contentBlocks[contentBlocks.length - 1]
            if (lastBlock?.type === 'text') {
              lastBlock.text += delta.text
            }
            yield { type: 'text', text: delta.text }
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            yield { type: 'tool_use_delta', partialJson: delta.partial_json }
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            // Accumulate thinking signature
            const lastBlock = contentBlocks[contentBlocks.length - 1]
            if (lastBlock?.type === 'thinking') {
              lastBlock.signature = (lastBlock.signature ?? '') + delta.signature
            }
          }
          break
        }

        case 'content_block_stop': {
          if (currentBlockType === 'tool_use') {
            yield { type: 'tool_use_end' }
          }
          yield { type: 'content_block_stop' }
          currentBlockType = null
          break
        }

        case 'message_stop': {
          // Parse tool_use input JSON from accumulated partial deltas
          // (the content blocks should have the final parsed input from the SDK)
          break
        }

        default:
          break
      }
    }

    // Get the final message from the stream
    const finalMessage = await stream.finalMessage()

    // Re-map content blocks from the final message (more reliable than accumulated)
    const finalBlocks = finalMessage.content.map(mapContentBlock)

    yield {
      type: 'message_done',
      response: {
        content: finalBlocks
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => b.text)
          .join(''),
        model: finalMessage.model,
        tokensIn: finalMessage.usage.input_tokens,
        tokensOut: finalMessage.usage.output_tokens,
        finishReason: finalMessage.stop_reason ?? 'unknown',
        contentBlocks: finalBlocks,
        cacheMetrics: {
          cacheCreationInputTokens: (finalMessage.usage as unknown as Record<string, number>).cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: (finalMessage.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0,
        },
      },
    }
  }

  /**
   * Embeddings are not supported by Anthropic/MiniMax — use OpenRouter for embeddings.
   * Throws an error directing callers to use OpenRouter.
   */
  async embeddings(_text: string): Promise<Float32Array> {
    throw new Error(
      'Anthropic/MiniMax provider does not support embeddings. ' +
      'Use OpenRouter with openai/text-embedding-3-small for embeddings.'
    )
  }

  // ─── Private Helpers ────────────────────────────────────

  /**
   * Build the messages array from the request.
   * Supports structured messages (preferred) and legacy flat messages.
   */
  private buildMessages(request: LLMRequest): Anthropic.MessageParam[] {
    // Prefer structured messages (native tool calling path)
    if (request.structuredMessages && request.structuredMessages.length > 0) {
      return request.structuredMessages.map(toAnthropicMessage)
    }

    // Legacy: flat ConversationMessage[] path
    if (request.messages && request.messages.length > 0) {
      return request.messages.map(msg => ({
        role: msg.role,
        content: msg.content,
      }))
    }

    // Single user message
    const messages: Anthropic.MessageParam[] = []

    if (request.context) {
      messages.push({
        role: 'user',
        content: `<context>\n${request.context}\n</context>\n\n${request.user}`,
      })
    } else if (request.images && request.images.length > 0) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: request.user },
          ...request.images.map(img => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: img.data,
            },
          })),
        ],
      })
    } else {
      messages.push({
        role: 'user',
        content: request.user,
      })
    }

    return messages
  }
}
