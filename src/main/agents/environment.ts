/**
 * Environment Awareness — Phase 10
 *
 * Centralizes all environment/system information that gets injected into
 * agent prompts. Replaces duplicated OS/path blocks across executor, coder,
 * planner, and orchestrator with a single source of truth.
 *
 * Two modes:
 *   - Full: injected into the first user message (workspace tree, system info)
 *   - Compact: injected on subsequent turns (context %, stale files, recent edits)
 */
import os from 'os'
import { readdir, stat } from 'fs/promises'
import { join, relative, sep } from 'path'
import type { FileContextTracker, FileTrackerStats } from './file-context-tracker'

// ─── Types ──────────────────────────────────────────────────

export interface EnvironmentOptions {
  /** Resolved working directory for the current task */
  workDir: string
  /** Brainwave home directory (agent's personal workspace) */
  brainwaveHomeDir: string
  /** Current context window usage as fraction 0-1 */
  contextUsageFraction?: number
  /** Total context limit in tokens */
  contextLimitTokens?: number
  /** FileContextTracker instance for the current task */
  fileTracker?: FileContextTracker
  /** Include the workspace directory tree (only on first message) */
  includeTree?: boolean
  /** Maximum depth for tree traversal */
  treeMaxDepth?: number
  /** Maximum total entries in the tree */
  treeMaxEntries?: number
}

// ─── Workspace Detection ────────────────────────────────────

/**
 * Detect the workspace/project directory for a task.
 *
 * Priority:
 *   1. Explicit path mentioned in the task description
 *   2. Parent task path references
 *   3. Brainwave home dir
 *   4. process.cwd()
 */
export function detectWorkspace(
  taskDescription: string,
  parentTask?: string,
  brainwaveHomeDir?: string
): string {
  // 1. Check if the task mentions an absolute path
  const absPathMatch = os.platform() === 'win32'
    ? taskDescription.match(/[A-Z]:\\[^\s"'<>|*?]+/i)
    : taskDescription.match(/\/(?:home|Users|opt|var|tmp|srv|etc|mnt|media)\/[^\s"'<>|*?]+/)

  if (absPathMatch) {
    // Walk up to find the nearest plausible project root
    const mentioned = absPathMatch[0].replace(/[/\\]+$/, '')
    return mentioned
  }

  // 2. Check parent task for path references
  if (parentTask) {
    const parentMatch = os.platform() === 'win32'
      ? parentTask.match(/[A-Z]:\\[^\s"'<>|*?]+/i)
      : parentTask.match(/\/(?:home|Users|opt|var|tmp|srv|etc|mnt|media)\/[^\s"'<>|*?]+/)

    if (parentMatch) {
      return parentMatch[0].replace(/[/\\]+$/, '')
    }
  }

  // 3. Brainwave home dir
  if (brainwaveHomeDir) return brainwaveHomeDir

  // 4. Fallback
  return process.cwd()
}

// ─── Directory Tree Builder ─────────────────────────────────

interface TreeOptions {
  maxDepth: number
  maxEntries: number
}

/**
 * Build an indented directory tree string for inclusion in prompts.
 * Respects common ignore patterns (node_modules, .git, dist, etc.).
 */
async function getDirectoryTree(
  rootDir: string,
  options: TreeOptions = { maxDepth: 3, maxEntries: 200 }
): Promise<string> {
  const IGNORE = new Set([
    'node_modules', '.git', '.next', '.nuxt', '__pycache__', '.cache',
    'dist', 'build', 'out', '.DS_Store', 'coverage', '.idea', '.vscode',
    '.dart_tool', '.pub-cache', 'Thumbs.db', '.gradle', '.android',
    '.ios', 'venv', '.venv', 'env', '.env', '.turbo', '.parcel-cache',
  ])

  const lines: string[] = []
  let entryCount = 0

  async function walk(dir: string, depth: number, prefix: string): Promise<void> {
    if (depth > options.maxDepth || entryCount >= options.maxEntries) return

    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    // Sort: directories first, then files, alphabetical within each group
    entries.sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1
      const bDir = b.isDirectory() ? 0 : 1
      if (aDir !== bDir) return aDir - bDir
      return a.name.localeCompare(b.name)
    })

    for (const entry of entries) {
      if (entryCount >= options.maxEntries) {
        lines.push(`${prefix}... (truncated, ${options.maxEntries} entries shown)`)
        return
      }

      if (IGNORE.has(entry.name)) continue

      entryCount++

      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`)
        await walk(join(dir, entry.name), depth + 1, prefix + '  ')
      } else {
        lines.push(`${prefix}${entry.name}`)
      }
    }
  }

  const rootName = rootDir.split(/[/\\]/).pop() || rootDir
  lines.push(`${rootName}/`)
  await walk(rootDir, 1, '  ')

  if (entryCount >= options.maxEntries) {
    lines.push(`\n(showing ${options.maxEntries} of possibly more entries)`)
  }

  return lines.join('\n')
}

// ─── System Info Block (for agent system prompts) ───────────

/**
 * Build the system environment block used in agent getSystemPrompt().
 * Replaces the duplicated OS/path blocks in executor, coder, planner, orchestrator.
 */
export function buildSystemEnvironmentBlock(brainwaveHomeDir: string): string {
  const platform = os.platform()
  const homeDir = os.homedir()
  const username = os.userInfo().username
  const hostname = os.hostname()
  const pathSep = platform === 'win32' ? '\\' : '/'
  const desktopPath = `${homeDir}${pathSep}Desktop`
  const documentsPath = `${homeDir}${pathSep}Documents`
  const downloadsPath = `${homeDir}${pathSep}Downloads`

  return `## System Environment
- Platform: ${platform} (${os.arch()})
- Hostname: ${hostname}
- Username: ${username}
- OS User Home: ${homeDir}
- **YOUR Home Directory (Brainwave Home): ${brainwaveHomeDir}**
- Desktop: ${desktopPath}
- Documents: ${documentsPath}
- Downloads: ${downloadsPath}
- Shell working directory (CWD): ${process.cwd()}
- Current Time: ${new Date().toISOString()}

ALWAYS use these REAL paths — NEVER guess or use placeholders like "YourUsername".

Your home directory is **${brainwaveHomeDir}**. When creating new files or projects, use this as the default location unless a different path is specified.
Note: The OS user home (${homeDir}) is the user's system home — NOT your home.`
}

// ─── Full Environment Details (first user message) ──────────

/**
 * Build the full `<environment_details>` block injected into the first
 * user message in executeWithTools(). Includes workspace tree, system
 * info, and context budget information.
 */
export async function getEnvironmentDetails(options: EnvironmentOptions): Promise<string> {
  const details: string[] = []
  const platform = os.platform()

  // 1. System info
  details.push(`OS: ${platform} ${os.arch()} (${os.release()})`)
  details.push(`Shell: ${platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh')}`)
  details.push(`Working Directory: ${options.workDir}`)
  details.push(`Home Directory: ${os.homedir()}`)
  details.push(`Brainwave Home: ${options.brainwaveHomeDir}`)
  details.push(`Current Time: ${new Date().toISOString()}`)

  // 2. Context budget
  if (options.contextLimitTokens) {
    const used = options.contextUsageFraction !== undefined
      ? ` (${(options.contextUsageFraction * 100).toFixed(0)}% used)`
      : ''
    details.push(`Context Window: ${formatTokens(options.contextLimitTokens)} tokens${used}`)
  }

  // 3. Workspace tree
  if (options.includeTree) {
    try {
      const tree = await getDirectoryTree(options.workDir, {
        maxDepth: options.treeMaxDepth ?? 3,
        maxEntries: options.treeMaxEntries ?? 200,
      })
      details.push(`\nWorkspace Files:\n${tree}`)
    } catch (err) {
      details.push(`\nWorkspace Files: (unable to read directory tree)`)
    }
  }

  // 4. File tracking info
  if (options.fileTracker) {
    const stats = options.fileTracker.getStats()

    if (stats.editedCount > 0) {
      const edited = options.fileTracker.getEditedFiles()
      const relPaths = edited.map((f) => shortenPath(f, options.workDir))
      details.push(`\nFiles Edited This Session (${stats.editedCount}):\n${relPaths.map(f => `  - ${f}`).join('\n')}`)
    }

    const stale = options.fileTracker.getStaleFiles()
    if (stale.length > 0) {
      const relPaths = stale.map((f) => shortenPath(f, options.workDir))
      details.push(`\n⚠ Stale Files (changed externally — re-read before editing):\n${relPaths.map(f => `  - ${f}`).join('\n')}`)
    }
  }

  return `<environment_details>\n${details.join('\n')}\n</environment_details>`
}

// ─── Compact Environment Details (subsequent turns) ─────────

/**
 * Build a compact environment update injected into user follow-up messages
 * or periodically during long tool loops. Much smaller than the full version.
 */
export function getCompactEnvironmentDetails(options: {
  workDir: string
  contextUsageFraction?: number
  fileTracker?: FileContextTracker
}): string {
  const parts: string[] = []

  // Context usage
  if (options.contextUsageFraction !== undefined) {
    parts.push(`Context: ${(options.contextUsageFraction * 100).toFixed(0)}% used`)
  }

  // Stale files
  if (options.fileTracker) {
    const stale = options.fileTracker.getStaleFiles()
    if (stale.length > 0) {
      const relPaths = stale.map((f) => shortenPath(f, options.workDir))
      parts.push(`⚠ Stale: ${relPaths.join(', ')}`)
    }

    const recent = options.fileTracker.getRecentlyAccessed(5)
    if (recent.length > 0) {
      const relPaths = recent.map((f) => shortenPath(f, options.workDir))
      parts.push(`Recent: ${relPaths.join(', ')}`)
    }
  }

  if (parts.length === 0) return ''
  return `\n<environment_details>\n${parts.join('\n')}\n</environment_details>`
}

// ─── Helpers ────────────────────────────────────────────────

/** Shorten an absolute path to a relative one based on workDir, for display */
function shortenPath(absPath: string, workDir: string): string {
  try {
    const rel = relative(workDir, absPath)
    // Only use relative if it doesn't escape the workDir
    if (!rel.startsWith('..')) return rel.replace(/\\/g, '/')
  } catch { /* ignore */ }
  return absPath
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}
