/**
 * Telegram Service — Two-way Telegram bot integration
 *
 * Features:
 *   1. Receive prompts from Telegram → submit to Orchestrator as tasks
 *   2. Send task completion/failure notifications to Telegram
 *   3. Forward agent-initiated notifications (via send_notification tool)
 *   4. Provide send_telegram_message tool for agents to explicitly message Telegram
 *
 * Configuration:
 *   - telegram_bot_token: Bot API token from @BotFather
 *   - telegram_chat_id: Authorized chat ID(s) for sending & receiving
 *
 * Uses grammy (TypeScript-first Telegram Bot API framework) with long polling.
 */

import { Bot, GrammyError, HttpError } from 'grammy'
import { getEventBus } from '../agents/event-bus'
import { getDatabase } from '../db/database'

// ─── Types ──────────────────────────────────────────────────

interface TelegramConfig {
  botToken: string
  chatId: string          // Primary chat ID for notifications
  authorizedIds: string[] // Chat IDs allowed to send prompts
}

type TaskSubmitFn = (prompt: string, sessionId: string) => Promise<void>

// ─── Telegram Service ───────────────────────────────────────

class TelegramService {
  private bot: Bot | null = null
  private config: TelegramConfig | null = null
  private initialized = false
  private running = false
  private submitTask: TaskSubmitFn | null = null

  // Track which Telegram messages map to which tasks (for reply threading)
  private pendingTasks = new Map<string, { chatId: string; messageId: number }>()

  /**
   * Initialize the Telegram bot.
   * Loads config from DB settings, sets up event bus listeners,
   * and starts long-polling if a bot token is configured.
   */
  async init(submitTaskFn: TaskSubmitFn): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    this.submitTask = submitTaskFn

    // Load config from DB
    this.config = this.loadConfig()
    if (!this.config) {
      console.log('[Telegram] No bot token configured — skipping initialization')
      return
    }

    // Wire up event bus listeners for outbound notifications
    this.setupEventListeners()

    // Create bot and start polling
    await this.startBot()
  }

  /**
   * Reconfigure the bot with new settings.
   * Called when user updates Telegram settings via the UI.
   */
  async reconfigure(): Promise<void> {
    await this.stopBot()
    this.config = this.loadConfig()
    if (!this.config) {
      console.log('[Telegram] Bot token removed — bot stopped')
      return
    }
    await this.startBot()
  }

  /**
   * Send a message to the configured Telegram chat.
   * Used by the send_telegram_message tool and for notifications.
   */
  async sendMessage(
    text: string,
    chatId?: string,
    options?: { replyToMessageId?: number; parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2' },
  ): Promise<boolean> {
    if (!this.bot || !this.config) {
      console.warn('[Telegram] Cannot send — bot not configured')
      return false
    }

    const targetChat = chatId ?? this.config.chatId
    if (!targetChat) {
      console.warn('[Telegram] Cannot send — no chat ID configured')
      return false
    }

    try {
      // Telegram has a 4096 character limit per message — split if needed
      const chunks = this.splitMessage(text, 4096)
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(targetChat, chunk, {
          parse_mode: options?.parseMode,
          reply_parameters: options?.replyToMessageId
            ? { message_id: options.replyToMessageId }
            : undefined,
        })
      }
      return true
    } catch (err) {
      console.error('[Telegram] Failed to send message:', err)
      return false
    }
  }

  /** Check if the bot is currently running */
  isRunning(): boolean {
    return this.running
  }

  /** Check if the bot is configured (has token + chat ID) */
  isConfigured(): boolean {
    return !!this.config?.botToken && !!this.config?.chatId
  }

  /** Get the bot's username (if running) */
  getBotInfo(): { username: string; running: boolean; configured: boolean } | null {
    return {
      username: this.bot?.botInfo?.username ?? 'unknown',
      running: this.running,
      configured: this.isConfigured(),
    }
  }

  /** Stop the bot gracefully */
  async stop(): Promise<void> {
    await this.stopBot()
  }

  // ─── Private: Bot Lifecycle ─────────────────────────────

  private async startBot(): Promise<void> {
    if (!this.config?.botToken) return

    try {
      this.bot = new Bot(this.config.botToken)

      // Command: /start — greet and show chat ID
      this.bot.command('start', async (ctx) => {
        const chatId = String(ctx.chat.id)
        await ctx.reply(
          `🧠 *Brainwave 2 Connected*\n\n` +
          `Your Chat ID: \`${chatId}\`\n\n` +
          `Send me any message and I'll process it as a task.\n\n` +
          `Commands:\n` +
          `/status — Check bot status\n` +
          `/cancel — Cancel the current task`,
          { parse_mode: 'Markdown' },
        )
        console.log(`[Telegram] /start from chat ${chatId}`)
      })

      // Command: /status — show bot status
      this.bot.command('status', async (ctx) => {
        const pendingCount = this.pendingTasks.size
        await ctx.reply(
          `🟢 *Brainwave 2 — Online*\n` +
          `Pending tasks: ${pendingCount}\n` +
          `Authorized: ${this.isAuthorized(String(ctx.chat.id)) ? 'Yes' : 'No'}`,
          { parse_mode: 'Markdown' },
        )
      })

      // Command: /cancel — cancel current tasks (placeholder)
      this.bot.command('cancel', async (ctx) => {
        await ctx.reply('⏹ Task cancellation not yet implemented. Use the desktop app to cancel tasks.')
      })

      // Handle all text messages → submit as tasks
      this.bot.on('message:text', async (ctx) => {
        const chatId = String(ctx.chat.id)

        // Authorization check
        if (!this.isAuthorized(chatId)) {
          await ctx.reply(
            `⛔ Unauthorized. Your Chat ID (${chatId}) is not authorized.\n` +
            `Add it in Brainwave 2 Settings → Telegram → Authorized Chat IDs.`,
          )
          console.warn(`[Telegram] Unauthorized message from chat ${chatId}`)
          return
        }

        const prompt = ctx.message.text.trim()
        if (!prompt) return

        // Acknowledge receipt
        await ctx.reply(`⏳ Processing: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`)

        // Create a session ID for this Telegram task
        const { randomUUID } = await import('node:crypto')
        const sessionId = randomUUID()

        // Track the pending task so we can reply when it completes
        this.pendingTasks.set(sessionId, { chatId, messageId: ctx.message.message_id })

        // Submit to orchestrator
        try {
          if (this.submitTask) {
            await this.submitTask(prompt, sessionId)
            console.log(`[Telegram] Task submitted from chat ${chatId}: "${prompt.slice(0, 80)}"`)
          }
        } catch (err) {
          console.error('[Telegram] Failed to submit task:', err)
          await ctx.reply(`❌ Failed to submit task: ${err instanceof Error ? err.message : 'Unknown error'}`)
          this.pendingTasks.delete(sessionId)
        }
      })

      // Handle photos with captions as tasks
      this.bot.on('message:photo', async (ctx) => {
        const chatId = String(ctx.chat.id)
        if (!this.isAuthorized(chatId)) return

        await ctx.reply('📸 Image processing is not yet supported via Telegram. Please send text prompts.')
      })

      // Error handler
      this.bot.catch((err) => {
        const ctx = err.ctx
        console.error(`[Telegram] Error handling update ${ctx.update.update_id}:`)
        const e = err.error
        if (e instanceof GrammyError) {
          console.error('[Telegram] Grammy error:', e.description)
        } else if (e instanceof HttpError) {
          console.error('[Telegram] HTTP error:', e)
        } else {
          console.error('[Telegram] Unknown error:', e)
        }
      })

      // Start long polling (non-blocking)
      this.bot.start({
        onStart: (botInfo) => {
          this.running = true
          console.log(`[Telegram] Bot @${botInfo.username} started (long polling)`)
        },
      })
    } catch (err) {
      console.error('[Telegram] Failed to start bot:', err)
      this.bot = null
      this.running = false
    }
  }

  private async stopBot(): Promise<void> {
    if (this.bot) {
      try {
        this.bot.stop()
      } catch {
        // Ignore errors during stop
      }
      this.bot = null
      this.running = false
      console.log('[Telegram] Bot stopped')
    }
  }

  // ─── Private: Event Bus Listeners ───────────────────────

  private setupEventListeners(): void {
    const bus = getEventBus()

    // Task completed → send result to Telegram
    bus.onEvent('task:completed', (data) => {
      const pending = data.sessionId ? this.pendingTasks.get(data.sessionId) : undefined
      if (pending && data.sessionId) {
        // This was a Telegram-initiated task — reply in the chat
        const result = typeof data.result === 'string'
          ? data.result
          : 'Task completed successfully.'

        this.sendMessage(
          `✅ *Task Completed*\n\n${this.escapeMarkdown(result)}`,
          pending.chatId,
          { replyToMessageId: pending.messageId, parseMode: 'Markdown' },
        ).catch(() => {
          // Fallback: send without markdown if escaping fails
          this.sendMessage(`✅ Task Completed\n\n${result}`, pending.chatId)
        })

        this.pendingTasks.delete(data.sessionId!)
      } else if (this.config?.chatId) {
        // Desktop-initiated task — still notify Telegram
        const result = typeof data.result === 'string'
          ? data.result.slice(0, 500)
          : 'Task completed.'

        this.sendMessage(`✅ *Task Completed*\n\n${this.escapeMarkdown(result)}`, undefined, {
          parseMode: 'Markdown',
        }).catch(() => {
          this.sendMessage(`✅ Task Completed\n\n${result}`)
        })
      }
    })

    // Task failed → notify Telegram
    bus.onEvent('task:failed', (data) => {
      const pending = data.sessionId ? this.pendingTasks.get(data.sessionId) : undefined
      const errorMsg = data.error ?? 'Unknown error'

      if (pending && data.sessionId) {
        this.sendMessage(
          `❌ *Task Failed*\n\n${this.escapeMarkdown(errorMsg)}`,
          pending.chatId,
          { replyToMessageId: pending.messageId, parseMode: 'Markdown' },
        ).catch(() => {
          this.sendMessage(`❌ Task Failed\n\n${errorMsg}`, pending.chatId)
        })
        this.pendingTasks.delete(data.sessionId!)
      } else if (this.config?.chatId) {
        this.sendMessage(
          `❌ *Task Failed*\n\n${this.escapeMarkdown(errorMsg)}`,
          undefined,
          { parseMode: 'Markdown' },
        ).catch(() => {
          this.sendMessage(`❌ Task Failed\n\n${errorMsg}`)
        })
      }
    })

    // Agent-initiated notification → forward to Telegram
    bus.onEvent('notification:send', (data) => {
      if (this.config?.chatId) {
        this.sendMessage(`🔔 *${this.escapeMarkdown(data.title)}*\n\n${this.escapeMarkdown(data.body)}`, undefined, {
          parseMode: 'Markdown',
        }).catch(() => {
          this.sendMessage(`🔔 ${data.title}\n\n${data.body}`)
        })
      }
    })

    console.log('[Telegram] Event bus listeners registered')
  }

  // ─── Private: Config ────────────────────────────────────

  private loadConfig(): TelegramConfig | null {
    try {
      const db = getDatabase()
      const tokenRow = db.get<{ value: string }>(
        `SELECT value FROM settings WHERE key = ?`,
        'telegram_bot_token',
      )
      const chatIdRow = db.get<{ value: string }>(
        `SELECT value FROM settings WHERE key = ?`,
        'telegram_chat_id',
      )
      const authorizedRow = db.get<{ value: string }>(
        `SELECT value FROM settings WHERE key = ?`,
        'telegram_authorized_ids',
      )

      const botToken = tokenRow?.value ? JSON.parse(tokenRow.value) : ''
      const chatId = chatIdRow?.value ? JSON.parse(chatIdRow.value) : ''
      const authorizedIds: string[] = authorizedRow?.value
        ? JSON.parse(authorizedRow.value)
        : []

      if (!botToken) return null

      // Always include the primary chat ID in authorized IDs
      const allAuthorized = new Set([...authorizedIds])
      if (chatId) allAuthorized.add(chatId)

      return {
        botToken,
        chatId,
        authorizedIds: [...allAuthorized],
      }
    } catch (err) {
      console.error('[Telegram] Failed to load config:', err)
      return null
    }
  }

  // ─── Private: Helpers ───────────────────────────────────

  private isAuthorized(chatId: string): boolean {
    if (!this.config) return false
    // If no authorized IDs configured, allow the primary chat ID only
    if (this.config.authorizedIds.length === 0) {
      return chatId === this.config.chatId
    }
    return this.config.authorizedIds.includes(chatId)
  }

  /** Escape special Markdown characters for Telegram */
  private escapeMarkdown(text: string): string {
    // Only escape characters that conflict with Telegram Markdown (v1)
    return text
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/\[/g, '\\[')
      .replace(/`/g, '\\`')
  }

  /** Split a long message into chunks respecting Telegram's 4096 char limit */
  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text]

    const chunks: string[] = []
    let remaining = text

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining)
        break
      }

      // Try to split at a newline near the limit
      let splitAt = remaining.lastIndexOf('\n', maxLength)
      if (splitAt < maxLength * 0.5) {
        // No good newline found — split at space
        splitAt = remaining.lastIndexOf(' ', maxLength)
      }
      if (splitAt < maxLength * 0.3) {
        // No good split point — hard split
        splitAt = maxLength
      }

      chunks.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt).trimStart()
    }

    return chunks
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: TelegramService | null = null

export function getTelegramService(): TelegramService {
  if (!instance) {
    instance = new TelegramService()
  }
  return instance
}
