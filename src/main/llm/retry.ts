/**
 * Retry & Circuit Breaker — Resilience utilities for LLM providers
 *
 * Exponential backoff with jitter for transient failures.
 * Circuit breaker pattern for persistent provider outages.
 * Used by OpenRouter and Replicate providers.
 */

// ─── Retry with Exponential Backoff ─────────────────────────

export interface RetryOptions {
  maxAttempts?: number      // default 3
  baseDelayMs?: number      // default 1000
  maxDelayMs?: number       // default 30000
  backoffMultiplier?: number // default 2
  retryableErrors?: string[] // error substrings that are retryable
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableErrors: [
    'rate_limit',
    'rate limit',
    '429',
    'timeout',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'socket hang up',
    '502',
    '503',
    '504',
    'overloaded',
    'capacity',
    'temporarily unavailable',
    'server error',
    '500',
  ],
}

/**
 * Check if an error is retryable (transient) vs permanent.
 */
function isRetryable(error: Error, retryablePatterns: string[]): boolean {
  const msg = error.message.toLowerCase()
  return retryablePatterns.some((pattern) => msg.includes(pattern.toLowerCase()))
}

/**
 * Sleep with jitter — adds ±25% randomness to prevent thundering herd.
 */
function sleepWithJitter(delayMs: number): Promise<void> {
  const jitter = delayMs * 0.25 * (Math.random() * 2 - 1) // ±25%
  const finalDelay = Math.max(100, delayMs + jitter)
  return new Promise((resolve) => setTimeout(resolve, finalDelay))
}

/**
 * Execute a function with exponential backoff retry.
 * Only retries on transient errors (rate limits, timeouts, server errors).
 * Throws immediately on permanent errors (auth, invalid request, etc.)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
  label = 'LLM call'
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options }
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // Don't retry non-retryable errors
      if (!isRetryable(lastError, opts.retryableErrors)) {
        throw lastError
      }

      // Don't retry on last attempt
      if (attempt === opts.maxAttempts) {
        break
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        opts.baseDelayMs * Math.pow(opts.backoffMultiplier, attempt - 1),
        opts.maxDelayMs
      )

      console.warn(
        `[Retry] ${label} attempt ${attempt}/${opts.maxAttempts} failed: ${lastError.message}. Retrying in ${Math.round(delay)}ms...`
      )

      await sleepWithJitter(delay)
    }
  }

  throw lastError!
}

// ─── Circuit Breaker ────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerOptions {
  failureThreshold?: number   // failures before opening (default 5)
  resetTimeoutMs?: number     // time before half-open test (default 60000 = 1 min)
  halfOpenMaxAttempts?: number // successful calls in half-open to close (default 2)
}

const DEFAULT_CB_OPTIONS: Required<CircuitBreakerOptions> = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  halfOpenMaxAttempts: 2,
}

export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failureCount = 0
  private successCount = 0
  private lastFailureTime = 0
  private opts: Required<CircuitBreakerOptions>

  constructor(
    readonly name: string,
    options?: CircuitBreakerOptions
  ) {
    this.opts = { ...DEFAULT_CB_OPTIONS, ...options }
  }

  /** Check if the circuit allows requests through */
  canExecute(): boolean {
    switch (this.state) {
      case 'closed':
        return true
      case 'open': {
        // Check if enough time has passed to try half-open
        const elapsed = Date.now() - this.lastFailureTime
        if (elapsed >= this.opts.resetTimeoutMs) {
          this.state = 'half-open'
          this.successCount = 0
          console.log(`[CircuitBreaker] ${this.name}: open → half-open (testing recovery)`)
          return true
        }
        return false
      }
      case 'half-open':
        return true
    }
  }

  /** Record a successful call */
  recordSuccess(): void {
    switch (this.state) {
      case 'closed':
        this.failureCount = 0
        break
      case 'half-open':
        this.successCount++
        if (this.successCount >= this.opts.halfOpenMaxAttempts) {
          this.state = 'closed'
          this.failureCount = 0
          this.successCount = 0
          console.log(`[CircuitBreaker] ${this.name}: half-open → closed (recovered)`)
        }
        break
    }
  }

  /** Record a failed call */
  recordFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()

    switch (this.state) {
      case 'closed':
        if (this.failureCount >= this.opts.failureThreshold) {
          this.state = 'open'
          console.warn(
            `[CircuitBreaker] ${this.name}: closed → OPEN (${this.failureCount} consecutive failures). Will retry in ${this.opts.resetTimeoutMs / 1000}s.`
          )
        }
        break
      case 'half-open':
        // Failed during recovery test — go back to open
        this.state = 'open'
        console.warn(`[CircuitBreaker] ${this.name}: half-open → OPEN (recovery test failed)`)
        break
    }
  }

  /** Get current state info */
  getStatus(): { state: CircuitState; failureCount: number; name: string } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      name: this.name,
    }
  }

  /** Force reset (e.g., after user reconfigures API key) */
  reset(): void {
    this.state = 'closed'
    this.failureCount = 0
    this.successCount = 0
    this.lastFailureTime = 0
  }
}

// ─── Provider Circuit Breakers (singletons) ─────────────────

const breakers = new Map<string, CircuitBreaker>()

export function getCircuitBreaker(providerName: string): CircuitBreaker {
  let cb = breakers.get(providerName)
  if (!cb) {
    cb = new CircuitBreaker(providerName)
    breakers.set(providerName, cb)
  }
  return cb
}

/** Get status of all circuit breakers */
export function getAllCircuitBreakerStatus(): Array<{ state: CircuitState; failureCount: number; name: string }> {
  return Array.from(breakers.values()).map((cb) => cb.getStatus())
}
