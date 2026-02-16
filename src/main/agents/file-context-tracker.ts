/**
 * File Context Tracker — Tracks files the agent has read or edited
 *
 * Phase 5: Context Management Revolution
 *
 * Provides:
 * - Tracking of which files the agent has interacted with (read/edit)
 * - Staleness detection: identifies files modified externally since last read
 * - Recently-accessed file lists for context prioritization
 * - Stats for environment_details injection
 *
 * Uses fs.statSync for mtime checks instead of watchers (simpler, no cleanup needed).
 */
import { statSync } from 'fs'

// ─── Types ──────────────────────────────────────────────────

interface FileTrackingEntry {
  /** Step when this file was first read by the agent */
  firstReadStep: number
  /** Step when this file was last read by the agent */
  lastReadStep: number
  /** Step when this file was last edited by the agent (if ever) */
  lastEditStep?: number
  /** File mtime at the time of last agent read (for staleness detection) */
  mtimeAtLastRead: number
  /** Number of times this file was read by the agent */
  readCount: number
}

export interface FileTrackerStats {
  totalTracked: number
  staleCount: number
  editedCount: number
  readCount: number
}

// ─── File Context Tracker ───────────────────────────────────

export class FileContextTracker {
  private files = new Map<string, FileTrackingEntry>()

  /**
   * Track a file read by the agent.
   * Records the step number and snapshots the file's mtime for staleness detection.
   */
  trackFileRead(path: string, step: number): void {
    const mtime = this.getMtime(path)
    const existing = this.files.get(path)

    if (existing) {
      existing.lastReadStep = step
      existing.mtimeAtLastRead = mtime
      existing.readCount++
    } else {
      this.files.set(path, {
        firstReadStep: step,
        lastReadStep: step,
        mtimeAtLastRead: mtime,
        readCount: 1,
      })
    }
  }

  /**
   * Track a file edit by the agent.
   * Resets staleness since we know the content (we just wrote it).
   */
  trackFileEdit(path: string, step: number): void {
    const mtime = this.getMtime(path)
    const existing = this.files.get(path)

    if (existing) {
      existing.lastEditStep = step
      existing.mtimeAtLastRead = mtime // our own edit — not stale
    } else {
      this.files.set(path, {
        firstReadStep: step,
        lastReadStep: step,
        lastEditStep: step,
        mtimeAtLastRead: mtime,
        readCount: 0,
      })
    }
  }

  /** Get all file paths the agent has interacted with */
  getFilesReadByAgent(): string[] {
    return [...this.files.keys()]
  }

  /**
   * Get files that have been modified externally since the agent last read them.
   * Compares current mtime to the mtime snapshot taken during the last read/edit.
   */
  getStaleFiles(): string[] {
    const stale: string[] = []
    for (const [path, entry] of this.files) {
      const currentMtime = this.getMtime(path)
      if (currentMtime > 0 && currentMtime > entry.mtimeAtLastRead) {
        stale.push(path)
      }
    }
    return stale
  }

  /**
   * Get the N most recently accessed files (read or edited).
   * Sorted by most recent interaction first.
   */
  getRecentlyAccessed(n = 5): string[] {
    return [...this.files.entries()]
      .sort((a, b) => {
        const aLast = Math.max(a[1].lastReadStep, a[1].lastEditStep ?? 0)
        const bLast = Math.max(b[1].lastReadStep, b[1].lastEditStep ?? 0)
        return bLast - aLast
      })
      .slice(0, n)
      .map(([path]) => path)
  }

  /** Get files edited by the agent (not just read) */
  getEditedFiles(): string[] {
    return [...this.files.entries()]
      .filter(([, entry]) => entry.lastEditStep !== undefined)
      .map(([path]) => path)
  }

  /** Get stats for environment_details injection */
  getStats(): FileTrackerStats {
    return {
      totalTracked: this.files.size,
      staleCount: this.getStaleFiles().length,
      editedCount: this.getEditedFiles().length,
      readCount: [...this.files.values()].reduce((sum, e) => sum + e.readCount, 0),
    }
  }

  /** Clear all tracking data */
  clear(): void {
    this.files.clear()
  }

  /** Get the mtime of a file (returns 0 if file doesn't exist or error) */
  private getMtime(path: string): number {
    try {
      return statSync(path).mtimeMs
    } catch {
      return 0
    }
  }
}
