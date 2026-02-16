/**
 * Custom Instructions & Rules Loader — Phase 12
 *
 * Provides a layered instruction system for injecting user-defined context
 * into agent system prompts. Instructions are loaded from multiple locations
 * with a clear priority order:
 *
 *   1. Global user instructions  (~/.brainwave/instructions.md)
 *   2. Project instructions      (.brainwave/instructions.md)
 *   3. Mode-specific instructions (.brainwave/instructions-{mode}.md)
 *   4. Mode-specific rule files   (.brainwave/rules-{mode}/*.md)
 *   5. Global rule files          (.brainwave/rules/*.md)
 *   6. Legacy .brainwaverules     (.brainwaverules)
 *
 * Also provides `.brainwaveignore` support for blocking agent access
 * to files/directories matching user-defined patterns.
 */

import { readFile, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, resolve, relative, sep } from 'path'
import { app } from 'electron'

// ─── Types ──────────────────────────────────────────────────

export interface InstructionSource {
  /** Where this instruction was loaded from */
  origin: 'global' | 'project' | 'mode' | 'mode-rules' | 'global-rules' | 'legacy'
  /** Absolute file path */
  filePath: string
  /** The instruction content */
  content: string
}

export interface LoadInstructionsOptions {
  /** The project's working directory (where .brainwave/ lives) */
  workDir: string
  /** Active mode slug (e.g. 'code', 'architect', 'ask') */
  mode?: string
}

// ─── Helpers ────────────────────────────────────────────────

/** Global config dir — usually %APPDATA%/brainwave2 or ~/.config/brainwave2 */
function getGlobalDir(): string {
  return app.getPath('userData')
}

/** Safely read a file, returning null if it doesn't exist or fails */
async function safeRead(filePath: string): Promise<string | null> {
  try {
    if (!existsSync(filePath)) return null
    const content = await readFile(filePath, 'utf-8')
    return content.trim() || null
  } catch {
    return null
  }
}

/** Safely list .md files in a directory */
async function listMdFiles(dirPath: string): Promise<string[]> {
  try {
    if (!existsSync(dirPath)) return []
    const entries = await readdir(dirPath)
    return entries
      .filter((f) => f.endsWith('.md'))
      .sort() // deterministic order
      .map((f) => join(dirPath, f))
  } catch {
    return []
  }
}

// ─── Instruction Loader ─────────────────────────────────────

/**
 * Load all applicable custom instructions for a given context.
 *
 * Returns an array of InstructionSource objects, each with content and metadata.
 * Instructions are in priority order (global first, legacy last).
 */
export async function loadCustomInstructions(
  options: LoadInstructionsOptions
): Promise<InstructionSource[]> {
  const instructions: InstructionSource[] = []
  const globalDir = getGlobalDir()
  const brainwaveDir = join(options.workDir, '.brainwave')

  // 1. Global user instructions (~/.brainwave/instructions.md)
  const globalPath = join(globalDir, 'instructions.md')
  const globalContent = await safeRead(globalPath)
  if (globalContent) {
    instructions.push({ origin: 'global', filePath: globalPath, content: globalContent })
  }

  // 2. Project instructions (.brainwave/instructions.md)
  const projectPath = join(brainwaveDir, 'instructions.md')
  const projectContent = await safeRead(projectPath)
  if (projectContent) {
    instructions.push({ origin: 'project', filePath: projectPath, content: projectContent })
  }

  // 3. Mode-specific instructions (.brainwave/instructions-{mode}.md)
  if (options.mode) {
    const modePath = join(brainwaveDir, `instructions-${options.mode}.md`)
    const modeContent = await safeRead(modePath)
    if (modeContent) {
      instructions.push({ origin: 'mode', filePath: modePath, content: modeContent })
    }
  }

  // 4. Mode-specific rule files (.brainwave/rules-{mode}/*.md)
  if (options.mode) {
    const modeRulesDir = join(brainwaveDir, `rules-${options.mode}`)
    const modeRuleFiles = await listMdFiles(modeRulesDir)
    for (const filePath of modeRuleFiles) {
      const content = await safeRead(filePath)
      if (content) {
        instructions.push({ origin: 'mode-rules', filePath, content })
      }
    }
  }

  // 5. Global rule files (.brainwave/rules/*.md)
  const globalRulesDir = join(brainwaveDir, 'rules')
  const globalRuleFiles = await listMdFiles(globalRulesDir)
  for (const filePath of globalRuleFiles) {
    const content = await safeRead(filePath)
    if (content) {
      instructions.push({ origin: 'global-rules', filePath, content })
    }
  }

  // 6. Legacy .brainwaverules file (project root)
  const legacyPath = join(options.workDir, '.brainwaverules')
  const legacyContent = await safeRead(legacyPath)
  if (legacyContent) {
    instructions.push({ origin: 'legacy', filePath: legacyPath, content: legacyContent })
  }

  return instructions
}

/**
 * Build a formatted instruction block ready for injection into system prompts.
 *
 * Returns empty string if no custom instructions are found.
 */
export function buildInstructionBlock(instructions: InstructionSource[]): string {
  if (instructions.length === 0) return ''

  const sections = instructions.map((inst) => {
    const label = {
      global: 'Global Instructions',
      project: 'Project Instructions',
      mode: 'Mode Instructions',
      'mode-rules': 'Mode Rules',
      'global-rules': 'Project Rules',
      legacy: 'Custom Rules',
    }[inst.origin]

    return `### ${label}\n${inst.content}`
  })

  return `\n\n## Custom Instructions\nThe user has provided the following instructions that MUST be followed:\n\n${sections.join('\n\n')}\n`
}

// ─── .brainwaveignore ───────────────────────────────────────

/**
 * A matcher for `.brainwaveignore` patterns.
 * Supports gitignore-style patterns:
 *   - `*.pem`        → match any .pem file
 *   - `secretes/`    → match the secrets directory and all contents
 *   - `.env`         → match .env file anywhere
 *   - `node_modules` → match node_modules directory
 *   - `!important.pem` → negate (un-ignore) a pattern
 *   - `#` lines      → comments
 *   - blank lines    → ignored
 */
export class IgnoreMatcher {
  private patterns: Array<{ regex: RegExp; negated: boolean }> = []
  private readonly projectDir: string

  constructor(projectDir: string, raw?: string) {
    this.projectDir = resolve(projectDir)
    if (raw) this.parse(raw)
  }

  /** Parse a .brainwaveignore file's raw content */
  parse(raw: string): void {
    this.patterns = []
    const lines = raw.split('\n')

    for (let line of lines) {
      line = line.trim()
      // Skip empty lines and comments
      if (!line || line.startsWith('#')) continue

      let negated = false
      if (line.startsWith('!')) {
        negated = true
        line = line.slice(1).trim()
        if (!line) continue
      }

      const regex = this.patternToRegex(line)
      this.patterns.push({ regex, negated })
    }
  }

  /** Check whether a given absolute path should be ignored */
  isIgnored(absPath: string): boolean {
    if (this.patterns.length === 0) return false

    const resolved = resolve(absPath)
    // Get path relative to project dir
    const rel = relative(this.projectDir, resolved)

    // If the path is outside the project dir, don't apply ignore rules
    if (rel.startsWith('..') || resolve(rel) === resolved) return false

    // Normalize to forward slashes for matching
    const normalized = rel.replace(/\\/g, '/')

    let ignored = false
    for (const { regex, negated } of this.patterns) {
      if (regex.test(normalized)) {
        ignored = !negated
      }
    }
    return ignored
  }

  /** Convert a gitignore-style glob pattern to a regex */
  private patternToRegex(pattern: string): RegExp {
    // Normalize separators
    let p = pattern.replace(/\\/g, '/')

    // Remove trailing slash (it means "directory only" — we treat all as matching)
    const dirOnly = p.endsWith('/')
    if (dirOnly) p = p.slice(0, -1)

    // If the pattern doesn't contain a slash, it matches at any depth
    const anchored = p.includes('/')

    // Escape regex special chars, then convert glob wildcards
    let regexStr = p
      .replace(/[.+^${}()|[\]]/g, '\\$&') // escape regex chars (NOT * and ?)
      .replace(/\*\*/g, '{{GLOBSTAR}}')     // preserve ** before * conversion
      .replace(/\*/g, '[^/]*')               // * matches anything except /
      .replace(/\?/g, '[^/]')                // ? matches single char except /
      .replace(/\{\{GLOBSTAR\}\}/g, '.*')    // ** matches everything including /

    if (!anchored) {
      // Unanchored patterns match at any depth: match the basename or any subpath
      regexStr = `(?:^|/)${regexStr}`
    } else {
      // Anchored patterns match from the root
      regexStr = `^${regexStr}`
    }

    // If directory pattern, also match all children
    if (dirOnly) {
      regexStr = `${regexStr}(?:/.*)?$`
    } else {
      // Match exact file OR directory + children
      regexStr = `${regexStr}(?:/.*)?$`
    }

    return new RegExp(regexStr, 'i')
  }

  get hasPatterns(): boolean {
    return this.patterns.length > 0
  }
}

/**
 * Load a `.brainwaveignore` file from the project directory.
 * Returns an IgnoreMatcher (always — empty if no file found).
 */
export async function loadIgnorePatterns(workDir: string): Promise<IgnoreMatcher> {
  const matcher = new IgnoreMatcher(workDir)
  const ignorePath = join(workDir, '.brainwaveignore')
  const content = await safeRead(ignorePath)
  if (content) {
    console.log(`[Instructions] Loaded .brainwaveignore from ${ignorePath}`)
    matcher.parse(content)
  }
  return matcher
}

// ─── Cached Instruction Manager ─────────────────────────────

/**
 * Singleton that caches loaded instructions and ignore patterns
 * for the current project. Re-loads when project dir changes.
 */
class InstructionManager {
  private cache: Map<string, InstructionSource[]> = new Map()
  private ignoreCache: Map<string, IgnoreMatcher> = new Map()

  /** Clear all caches (call when project changes) */
  clear(): void {
    this.cache.clear()
    this.ignoreCache.clear()
  }

  /**
   * Get cached instructions for a given context, loading if needed.
   * Cache key is `${workDir}::${mode ?? 'default'}`.
   */
  async getInstructions(options: LoadInstructionsOptions): Promise<InstructionSource[]> {
    const key = `${options.workDir}::${options.mode ?? 'default'}`
    if (this.cache.has(key)) return this.cache.get(key)!

    const instructions = await loadCustomInstructions(options)
    this.cache.set(key, instructions)

    if (instructions.length > 0) {
      console.log(
        `[Instructions] Loaded ${instructions.length} instruction source(s) for` +
        ` workDir=${options.workDir} mode=${options.mode ?? 'default'}:`,
        instructions.map((i) => `${i.origin} → ${i.filePath}`).join(', ')
      )
    }

    return instructions
  }

  /**
   * Get cached ignore matcher for a given work dir, loading if needed.
   */
  async getIgnoreMatcher(workDir: string): Promise<IgnoreMatcher> {
    if (this.ignoreCache.has(workDir)) return this.ignoreCache.get(workDir)!

    const matcher = await loadIgnorePatterns(workDir)
    this.ignoreCache.set(workDir, matcher)
    return matcher
  }

  /**
   * Build the formatted instruction block for injection into system prompts.
   */
  async buildBlock(options: LoadInstructionsOptions): Promise<string> {
    const instructions = await this.getInstructions(options)
    return buildInstructionBlock(instructions)
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: InstructionManager | null = null

export function getInstructionManager(): InstructionManager {
  if (!instance) instance = new InstructionManager()
  return instance
}
