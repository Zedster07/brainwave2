/**
 * Rule Loader — Loads and saves YAML rule config files
 *
 * Falls back to default rules if config files don't exist.
 * Config directory: <userData>/brainwave2/rules/
 */
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { SafetyRules, BehaviorRules } from './types'

// ─── YAML Parser (lightweight, no dependency) ───────────────
// We use a simple parser since rules are structured but not deeply nested.
// For full YAML support, swap with 'js-yaml' in the future.

function parseYaml(content: string): unknown {
  // Remove comments and parse as JSON-compatible structure
  // For now, we store as JSON-in-YAML for reliability
  const stripped = content
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
    .trim()

  try {
    return JSON.parse(stripped)
  } catch {
    // Fallback: try to extract the JSON block if wrapped in yaml frontmatter
    const jsonMatch = stripped.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
    throw new Error('Failed to parse rules file. Expected JSON format.')
  }
}

function toYaml(data: unknown): string {
  return `# Brainwave 2 — Rules Configuration\n# Auto-generated. Edit with care.\n\n${JSON.stringify(data, null, 2)}\n`
}

// ─── Default Rules ──────────────────────────────────────────

const DEFAULT_SAFETY_RULES: SafetyRules = {
  filesystem: {
    blocked_paths: [
      'C:\\Windows\\**',
      'C:\\Program Files\\**',
      '/etc/**',
      '/usr/**',
      '/bin/**',
      '/sbin/**',
      '/System/**',
      '/Library/**',
    ],
    user_blocked_paths: [],
    blocked_extensions: ['.exe', '.bat', '.cmd', '.ps1', '.vbs', '.reg'],
    blocked_operations: [
      { pattern: 'rm -rf /', reason: 'Recursive root deletion' },
      { pattern: 'del /s /q C:\\', reason: 'Recursive system deletion' },
      { pattern: 'format', reason: 'Disk format' },
    ],
    max_file_size_mb: 100,
    max_files_per_operation: 50,
  },
  shell: {
    blocked_commands: [
      'shutdown', 'restart', 'reboot', 'halt', 'poweroff',
      'reg delete', 'diskpart', 'fdisk',
      'format', 'mkfs',
      'rm -rf /',
      'dd if=/dev/zero',
    ],
    blocked_patterns: [
      { pattern: ':(){ :|:& };:', reason: 'Fork bomb' },
      { pattern: '> /dev/sda', reason: 'Direct disk write' },
      { pattern: 'chmod -R 777 /', reason: 'Recursive permission change on root' },
    ],
    max_execution_time_seconds: 300,
    allow_shell: true,
  },
  network: {
    blocked_domains: [],
    max_request_size_mb: 50,
    allow_outbound: true,
  },
  secrets: {
    never_log: ['API_KEY', 'PASSWORD', 'TOKEN', 'SECRET', 'CREDENTIAL', 'PRIVATE_KEY'],
    never_include_in_memory: true,
    redaction_pattern: '(?:api[_-]?key|password|token|secret|credential|private[_-]?key)\\s*[:=]\\s*["\']?([^"\'\\s]+)',
  },
}

const DEFAULT_BEHAVIOR_RULES: BehaviorRules = {
  behavioral: [
    { rule: 'Always explain your reasoning before taking action', priority: 'high', enabled: true },
    { rule: 'When uncertain, ask the user rather than guessing', priority: 'high', enabled: true },
    { rule: 'Be transparent about confidence levels', priority: 'medium', enabled: true },
    { rule: 'Prefer simpler solutions unless complexity is justified', priority: 'medium', enabled: true },
    { rule: 'Report progress at each major step', priority: 'low', enabled: true },
  ],
  quality: {
    code: [
      { rule: 'Always include error handling in generated code', applies_to: ['coder', 'reviewer'], enabled: true },
      { rule: 'Follow existing project patterns and conventions', applies_to: ['coder'], enabled: true },
      { rule: 'Add comments for complex logic', applies_to: ['coder'], enabled: true },
      { rule: 'Never commit credentials or secrets in code', applies_to: ['coder', 'reviewer'], enabled: true },
    ],
    research: [
      { rule: 'Always cite sources with URLs when available', applies_to: ['researcher'], enabled: true },
      { rule: 'Cross-reference multiple sources before confident answers', applies_to: ['researcher'], enabled: true },
      { rule: 'Flag information that may be outdated', applies_to: ['researcher'], enabled: true },
    ],
    general: [
      { rule: 'Review output for factual accuracy before reporting', applies_to: ['reviewer'], enabled: true },
      { rule: 'Check for logical consistency across sub-task results', applies_to: ['reviewer'], enabled: true },
    ],
  },
  routing: [
    { when: 'task mentions a person by name', action: 'check People Database before starting', enabled: true },
    { when: 'task involves writing or modifying code', action: 'assign to coder agent', enabled: true },
    { when: 'task requires finding information or facts', action: 'assign to researcher agent', enabled: true },
    { when: 'output quality is critical', action: 'always include reviewer step', enabled: true },
  ],
  memory: {
    always_remember: [
      "People's names, roles, and relationships",
      'User corrections and preferences',
      'Project context and decisions',
      'Successful task patterns',
      'User-stated rules and constraints',
    ],
    never_remember: [
      'API keys, passwords, or secrets',
      'Financial account numbers',
      'Health or medical information unless explicitly asked',
    ],
    ask_before_remembering: [
      'Personal or sensitive information about people',
      'Controversial opinions or statements',
    ],
  },
  escalation: [
    { when: 'confidence < 0.4', action: 'ask_user', message: 'Low confidence — should I proceed?', enabled: true },
    { when: 'action is destructive (delete, overwrite)', action: 'ask_user', message: 'This action is destructive. Confirm?', enabled: true },
    { when: 'cost exceeds $0.50 for a single task', action: 'warn_user', message: 'This task may be expensive.', enabled: true },
    { when: 'task touches files outside workspace', action: 'ask_user', message: 'This task wants to access files outside the workspace.', enabled: true },
  ],
  cost: {
    rules: [
      { when: 'task complexity is trivial or simple', action: 'use cheapest available model', enabled: true },
      { when: 'task is research-heavy', action: 'use model with large context window', enabled: true },
    ],
    monthly_budget_alert: 50.0,
    prefer_cheap_for: ['trivial', 'simple'],
  },
}

// ─── Loader ─────────────────────────────────────────────────

export class RuleLoader {
  private configDir: string

  constructor(configDir?: string) {
    this.configDir = configDir ?? join(app.getPath('userData'), 'rules')
    this.ensureConfigDir()
  }

  private ensureConfigDir(): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true })
    }
  }

  /** Get the path to a rules file */
  getFilePath(filename: string): string {
    return join(this.configDir, filename)
  }

  // ─── Safety Rules ─────────────────────────────────────

  loadSafetyRules(): SafetyRules {
    const filePath = this.getFilePath('safety.rules.json')

    if (!existsSync(filePath)) {
      // Write defaults on first run
      this.saveSafetyRules(DEFAULT_SAFETY_RULES)
      return { ...DEFAULT_SAFETY_RULES }
    }

    try {
      const content = readFileSync(filePath, 'utf-8')
      const parsed = parseYaml(content) as SafetyRules
      // Merge with defaults to ensure all fields exist
      return this.mergeSafety(DEFAULT_SAFETY_RULES, parsed)
    } catch (err) {
      console.error('[RuleLoader] Failed to load safety rules, using defaults:', err)
      return { ...DEFAULT_SAFETY_RULES }
    }
  }

  saveSafetyRules(rules: SafetyRules): void {
    const filePath = this.getFilePath('safety.rules.json')
    writeFileSync(filePath, toYaml(rules), 'utf-8')
  }

  // ─── Behavior Rules ───────────────────────────────────

  loadBehaviorRules(): BehaviorRules {
    const filePath = this.getFilePath('behavior.rules.json')

    if (!existsSync(filePath)) {
      // Write defaults on first run
      this.saveBehaviorRules(DEFAULT_BEHAVIOR_RULES)
      return { ...DEFAULT_BEHAVIOR_RULES }
    }

    try {
      const content = readFileSync(filePath, 'utf-8')
      const parsed = parseYaml(content) as BehaviorRules
      return this.mergeBehavior(DEFAULT_BEHAVIOR_RULES, parsed)
    } catch (err) {
      console.error('[RuleLoader] Failed to load behavior rules, using defaults:', err)
      return { ...DEFAULT_BEHAVIOR_RULES }
    }
  }

  saveBehaviorRules(rules: BehaviorRules): void {
    const filePath = this.getFilePath('behavior.rules.json')
    writeFileSync(filePath, toYaml(rules), 'utf-8')
  }

  // ─── Merge Helpers ────────────────────────────────────

  private mergeSafety(defaults: SafetyRules, loaded: Partial<SafetyRules>): SafetyRules {
    return {
      filesystem: { ...defaults.filesystem, ...loaded.filesystem },
      shell: { ...defaults.shell, ...loaded.shell },
      network: { ...defaults.network, ...loaded.network },
      secrets: { ...defaults.secrets, ...loaded.secrets },
    }
  }

  private mergeBehavior(defaults: BehaviorRules, loaded: Partial<BehaviorRules>): BehaviorRules {
    return {
      behavioral: loaded.behavioral ?? defaults.behavioral,
      quality: loaded.quality ?? defaults.quality,
      routing: loaded.routing ?? defaults.routing,
      memory: loaded.memory ?? defaults.memory,
      escalation: loaded.escalation ?? defaults.escalation,
      cost: loaded.cost ?? defaults.cost,
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: RuleLoader | null = null

export function getRuleLoader(): RuleLoader {
  if (!instance) {
    instance = new RuleLoader()
  }
  return instance
}

export { DEFAULT_SAFETY_RULES, DEFAULT_BEHAVIOR_RULES }
