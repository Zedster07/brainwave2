/**
 * Stream Repetition Watchdog — Detects when an LLM is stuck in a loop
 * outputting the same text segments repeatedly during streaming.
 *
 * Works by splitting incoming stream text into fixed-size segments
 * and tracking consecutive identical segments. When the threshold
 * is exceeded, the watchdog signals that the stream should be aborted.
 *
 * Usage:
 *   const watchdog = new StreamRepetitionWatchdog()
 *   for await (const chunk of stream) {
 *     watchdog.feed(chunk)
 *     if (watchdog.isTriggered()) { break }  // abort stream
 *   }
 */

// ─── Configuration ──────────────────────────────────────────

/** Number of characters per segment for comparison */
const SEGMENT_SIZE = 200

/** Number of consecutive identical segments to trigger abort */
const MAX_IDENTICAL_SEGMENTS = 3

// ─── Watchdog ───────────────────────────────────────────────

export class StreamRepetitionWatchdog {
  private buffer = ''
  private lastSegment = ''
  private consecutiveIdentical = 0
  private triggered = false
  private totalChars = 0

  private readonly segmentSize: number
  private readonly maxIdenticalSegments: number

  constructor(
    segmentSize = SEGMENT_SIZE,
    maxIdenticalSegments = MAX_IDENTICAL_SEGMENTS
  ) {
    this.segmentSize = segmentSize
    this.maxIdenticalSegments = maxIdenticalSegments
  }

  /**
   * Feed a chunk of streaming text into the watchdog.
   * Call this for every chunk received from the LLM stream.
   */
  feed(chunk: string): void {
    if (this.triggered) return

    this.buffer += chunk
    this.totalChars += chunk.length

    // Process complete segments from the buffer
    while (this.buffer.length >= this.segmentSize) {
      const segment = this.buffer.slice(0, this.segmentSize)
      this.buffer = this.buffer.slice(this.segmentSize)

      // Normalize: collapse whitespace for comparison
      const normalized = segment.replace(/\s+/g, ' ').trim()

      if (normalized === this.lastSegment && normalized.length > 20) {
        this.consecutiveIdentical++
        if (this.consecutiveIdentical >= this.maxIdenticalSegments) {
          this.triggered = true
          console.warn(
            `[StreamWatchdog] Repetition detected: ${this.consecutiveIdentical} identical ` +
            `${this.segmentSize}-char segments after ${this.totalChars} total chars. ` +
            `Repeating: "${normalized.slice(0, 80)}..."`
          )
          return
        }
      } else {
        this.consecutiveIdentical = 1
        this.lastSegment = normalized
      }
    }
  }

  /**
   * Whether the watchdog has been triggered (repetition detected).
   */
  isTriggered(): boolean {
    return this.triggered
  }

  /**
   * Get diagnostics for logging.
   */
  getDiagnostics(): {
    triggered: boolean
    totalChars: number
    consecutiveIdentical: number
    lastSegmentPreview: string
  } {
    return {
      triggered: this.triggered,
      totalChars: this.totalChars,
      consecutiveIdentical: this.consecutiveIdentical,
      lastSegmentPreview: this.lastSegment.slice(0, 80),
    }
  }

  /**
   * Reset the watchdog for reuse.
   */
  reset(): void {
    this.buffer = ''
    this.lastSegment = ''
    this.consecutiveIdentical = 0
    this.triggered = false
    this.totalChars = 0
  }
}
