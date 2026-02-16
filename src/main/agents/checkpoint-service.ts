/**
 * Checkpoint Service — Shadow git repository for task-level undo/redo
 *
 * Creates a hidden git repo in a temp directory with the worktree pointed
 * at the actual project directory. After each write operation, the agent
 * auto-commits a snapshot so the user can roll back to any point.
 *
 * This does NOT interfere with the user's own git repo — it uses an
 * isolated GIT_DIR in the OS temp directory.
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { getDatabase } from '../db/database'

const execFileAsync = promisify(execFile)

/** Max time (ms) to wait for any single git command */
const GIT_TIMEOUT = 10_000

// ─── Types ──────────────────────────────────────────────────

export interface CheckpointEntry {
  id: string
  taskId: string
  step: number
  tool: string
  filePath: string
  commitHash: string
  description: string
  createdAt: string
}

export interface CheckpointDiff {
  files: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>
  patch: string
}

// ─── Checkpoint Tracker (shadow git) ────────────────────────

export class CheckpointTracker {
  private shadowGitDir: string
  private workDir: string
  private initialized = false

  constructor(workDir: string) {
    this.workDir = workDir
    // Deterministic hash of workDir → unique shadow dir per project
    const hash = createHash('sha256').update(workDir).digest('hex').slice(0, 16)
    this.shadowGitDir = path.join(os.tmpdir(), 'brainwave-checkpoints', hash)
  }

  /** Initialize the shadow git repo (idempotent) */
  async init(): Promise<void> {
    if (this.initialized) return

    // Ensure shadow dir exists
    mkdirSync(this.shadowGitDir, { recursive: true })

    // Check if already initialized
    const gitDir = path.join(this.shadowGitDir, '.git')
    if (!existsSync(gitDir)) {
      // Init bare repo
      await this.git('init')
      // Configure
      await this.git('config', 'user.name', 'Brainwave')
      await this.git('config', 'user.email', 'brainwave@local')
      // Initial commit (empty)
      await this.git('commit', '--allow-empty', '-m', 'Initial checkpoint')
    }

    this.initialized = true
    console.log(`[Checkpoint] Shadow repo ready at ${this.shadowGitDir}`)
  }

  /**
   * Take a checkpoint snapshot of the current working directory state.
   * Only stages the specific file that was modified for efficiency.
   */
  async commit(step: number, tool: string, filePath: string, description?: string): Promise<string> {
    if (!this.initialized) await this.init()

    const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.workDir, filePath)
    const relPath = path.relative(this.workDir, absPath)

    try {
      // Stage the specific file
      await this.git('add', '--force', '--', relPath)

      // Check if there are staged changes
      const { stdout: status } = await this.gitRaw('diff', '--cached', '--name-only')
      if (!status.trim()) {
        // No actual changes to commit — skip
        return ''
      }

      const msg = description ?? `Step ${step}: ${tool} on ${relPath}`
      await this.git('commit', '-m', msg)

      // Get commit hash
      const { stdout: hash } = await this.gitRaw('rev-parse', 'HEAD')
      const commitHash = hash.trim()

      console.log(`[Checkpoint] Committed ${commitHash.slice(0, 8)} — ${msg}`)
      return commitHash
    } catch (err) {
      console.warn(`[Checkpoint] Failed to commit step ${step}:`, err instanceof Error ? err.message : err)
      return ''
    }
  }

  /**
   * Roll back the working directory to a specific commit.
   * Restores all files to the state they were in at that checkpoint.
   */
  async rollback(commitHash: string): Promise<void> {
    if (!this.initialized) await this.init()

    console.log(`[Checkpoint] Rolling back to ${commitHash.slice(0, 8)}...`)
    await this.git('checkout', commitHash, '--', '.')
    console.log(`[Checkpoint] Rollback complete`)
  }

  /** Get the diff between two commits (or from a commit to HEAD) */
  async getDiff(fromHash: string, toHash?: string): Promise<CheckpointDiff> {
    if (!this.initialized) await this.init()

    const range = toHash ? `${fromHash}..${toHash}` : `${fromHash}..HEAD`

    // Get file statuses
    const { stdout: nameStatus } = await this.gitRaw('diff', '--name-status', range)
    const files = nameStatus
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...pathParts] = line.split('\t')
        const filePath = pathParts.join('\t')
        const fileStatus = status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified'
        return { path: filePath, status: fileStatus as 'added' | 'modified' | 'deleted' }
      })

    // Get full patch
    let patch = ''
    try {
      const { stdout } = await this.gitRaw('diff', range)
      patch = stdout
    } catch {
      patch = '(diff unavailable)'
    }

    return { files, patch }
  }

  /** Get commit history */
  async getHistory(limit = 50): Promise<Array<{ hash: string; message: string; timestamp: string }>> {
    if (!this.initialized) await this.init()

    try {
      const { stdout } = await this.gitRaw(
        'log',
        `--max-count=${limit}`,
        '--format=%H|%s|%aI'
      )
      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, message, timestamp] = line.split('|')
          return { hash, message, timestamp }
        })
    } catch {
      return []
    }
  }

  /** Clean up the shadow repo */
  async dispose(): Promise<void> {
    // Shadow repo is in temp dir — OS will clean it up eventually
    // We don't delete it because the user might want to inspect it
    this.initialized = false
  }

  // ─── Git Helpers ──────────────────────────────────────────

  private async git(...args: string[]): Promise<void> {
    await this.gitRaw(...args)
  }

  private async gitRaw(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, {
      cwd: this.shadowGitDir,
      timeout: GIT_TIMEOUT,
      env: {
        ...process.env,
        GIT_DIR: path.join(this.shadowGitDir, '.git'),
        GIT_WORK_TREE: this.workDir,
      },
    })
  }
}

// ─── Checkpoint Service (DB persistence + tracker) ──────────

export class CheckpointService {
  private trackers = new Map<string, CheckpointTracker>()

  /** Get or create a tracker for a working directory */
  getTracker(workDir: string): CheckpointTracker {
    let tracker = this.trackers.get(workDir)
    if (!tracker) {
      tracker = new CheckpointTracker(workDir)
      this.trackers.set(workDir, tracker)
    }
    return tracker
  }

  /**
   * Create a checkpoint: commit to shadow git + persist to SQLite
   */
  async createCheckpoint(
    workDir: string,
    taskId: string,
    step: number,
    tool: string,
    filePath: string,
    description?: string
  ): Promise<CheckpointEntry | null> {
    const tracker = this.getTracker(workDir)
    const commitHash = await tracker.commit(step, tool, filePath, description)

    if (!commitHash) return null // No changes to commit

    const entry: CheckpointEntry = {
      id: randomUUID(),
      taskId,
      step,
      tool,
      filePath,
      commitHash,
      description: description ?? `Step ${step}: ${tool} on ${filePath}`,
      createdAt: new Date().toISOString(),
    }

    // Persist to SQLite
    try {
      const db = getDatabase()
      db.run(
        `INSERT INTO task_checkpoints (id, task_id, step, tool, file_path, commit_hash, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.id,
        entry.taskId,
        entry.step,
        entry.tool,
        entry.filePath,
        entry.commitHash,
        entry.description,
        entry.createdAt
      )
    } catch (err) {
      console.warn('[Checkpoint] Failed to persist checkpoint to DB:', err instanceof Error ? err.message : err)
    }

    return entry
  }

  /** Get all checkpoints for a task */
  getCheckpoints(taskId: string): CheckpointEntry[] {
    try {
      const db = getDatabase()
      return db.all<CheckpointEntry>(
        `SELECT id, task_id as taskId, step, tool, file_path as filePath, commit_hash as commitHash, description, created_at as createdAt
         FROM task_checkpoints WHERE task_id = ? ORDER BY step ASC`,
        taskId
      )
    } catch {
      return []
    }
  }

  /** Roll back to a specific checkpoint */
  async rollbackToCheckpoint(
    workDir: string,
    taskId: string,
    checkpointId: string
  ): Promise<void> {
    const checkpoints = this.getCheckpoints(taskId)
    const target = checkpoints.find((c) => c.id === checkpointId)
    if (!target) {
      throw new Error(`Checkpoint ${checkpointId} not found for task ${taskId}`)
    }

    const tracker = this.getTracker(workDir)
    await tracker.rollback(target.commitHash)

    // Remove checkpoints after the rollback point
    try {
      const db = getDatabase()
      db.run(
        `DELETE FROM task_checkpoints WHERE task_id = ? AND step > ?`,
        taskId,
        target.step
      )
    } catch (err) {
      console.warn('[Checkpoint] Failed to clean up checkpoints after rollback:', err instanceof Error ? err.message : err)
    }
  }

  /** Get diff between two checkpoints */
  async getDiff(
    workDir: string,
    fromCheckpointId: string,
    toCheckpointId?: string,
    taskId?: string
  ): Promise<CheckpointDiff> {
    const allCheckpoints = taskId ? this.getCheckpoints(taskId) : []
    const from = allCheckpoints.find((c) => c.id === fromCheckpointId)
    const to = toCheckpointId ? allCheckpoints.find((c) => c.id === toCheckpointId) : undefined

    if (!from) throw new Error(`Checkpoint ${fromCheckpointId} not found`)

    const tracker = this.getTracker(workDir)
    return tracker.getDiff(from.commitHash, to?.commitHash)
  }

  /** Clean up all trackers */
  async dispose(): Promise<void> {
    for (const tracker of this.trackers.values()) {
      await tracker.dispose()
    }
    this.trackers.clear()
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: CheckpointService | null = null

export function getCheckpointService(): CheckpointService {
  if (!instance) {
    instance = new CheckpointService()
  }
  return instance
}
