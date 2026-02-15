/**
 * CancellationToken — Cooperative cancellation for agent tasks
 *
 * Provides a structured way to cancel in-flight LLM calls, tool executions,
 * and the agent tool loop. Uses AbortController under the hood so the
 * AbortSignal can be threaded into fetch/OpenAI SDK calls.
 *
 * Usage:
 *   const token = CancellationToken.create()
 *   // Pass token.signal to LLM requests
 *   // Check token.isCancelled in loops
 *   // Call token.cancel() to abort everything
 */

// ─── CancellationToken ─────────────────────────────────────

export class CancellationToken {
  private controller: AbortController
  private callbacks: Array<() => void> = []
  private _isCancelled = false
  private _reason: string | undefined

  private constructor() {
    this.controller = new AbortController()
    // Prevent MaxListenersExceededWarning in long-running agent loops
    // Each think() call adds a listener when passing signal to the SDK
    if (typeof (this.controller.signal as any).setMaxListeners === 'function') {
      ;(this.controller.signal as any).setMaxListeners(100)
    }
  }

  /** Create a new cancellation token */
  static create(): CancellationToken {
    return new CancellationToken()
  }

  /** Whether cancellation has been requested */
  get isCancelled(): boolean {
    return this._isCancelled
  }

  /** The reason for cancellation (if any) */
  get reason(): string | undefined {
    return this._reason
  }

  /** The AbortSignal to pass into fetch/SDK calls */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Request cancellation — aborts in-flight HTTP requests and notifies listeners */
  cancel(reason = 'Task cancelled by user'): void {
    if (this._isCancelled) return
    this._isCancelled = true
    this._reason = reason

    // Abort any in-flight HTTP requests (OpenAI SDK, fetch, etc.)
    this.controller.abort(reason)

    // Notify registered callbacks
    for (const cb of this.callbacks) {
      try {
        cb()
      } catch (err) {
        console.warn('[CancellationToken] Callback error:', err)
      }
    }
    this.callbacks.length = 0
  }

  /** Register a callback to be called when cancellation is requested */
  onCancel(fn: () => void): void {
    if (this._isCancelled) {
      // Already cancelled — invoke immediately
      fn()
      return
    }
    this.callbacks.push(fn)
  }

  /** Throw if cancelled — useful as a guard in async functions */
  throwIfCancelled(): void {
    if (this._isCancelled) {
      throw new CancellationError(this._reason ?? 'Cancelled')
    }
  }
}

// ─── CancellationError ──────────────────────────────────────

export class CancellationError extends Error {
  readonly isCancellation = true

  constructor(message = 'Operation cancelled') {
    super(message)
    this.name = 'CancellationError'
  }

  /** Type guard for catch blocks */
  static is(err: unknown): err is CancellationError {
    return err instanceof CancellationError ||
      (err instanceof Error && (err as any).isCancellation === true)
  }
}

// ─── Task → Token Registry ─────────────────────────────────

const tokenRegistry = new Map<string, CancellationToken>()

/** Create and register a cancellation token for a task */
export function createTaskToken(taskId: string): CancellationToken {
  // Cancel any existing token for this task
  const existing = tokenRegistry.get(taskId)
  if (existing && !existing.isCancelled) {
    existing.cancel('Superseded by new task token')
  }

  const token = CancellationToken.create()
  tokenRegistry.set(taskId, token)

  // Auto-cleanup after 10 minutes
  setTimeout(() => tokenRegistry.delete(taskId), 10 * 60 * 1000)

  return token
}

/** Get the cancellation token for a task (if it exists) */
export function getTaskToken(taskId: string): CancellationToken | undefined {
  return tokenRegistry.get(taskId)
}

/** Cancel a task's token and remove it from the registry */
export function cancelTaskToken(taskId: string, reason?: string): boolean {
  const token = tokenRegistry.get(taskId)
  if (!token || token.isCancelled) return false
  token.cancel(reason)
  return true
}
