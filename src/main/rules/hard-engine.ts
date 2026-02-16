/**
 * Hard Rules Engine — Safety Guardian
 *
 * Code-enforced safety rules. Every agent action passes through this
 * gate BEFORE execution. Fail-closed: if a rule can't be evaluated,
 * the action is DENIED.
 *
 * This engine cannot be bypassed by agents, prompts, or soft rules.
 */
import { getRuleLoader } from './rule-loader'
import { getEventBus } from '../agents/event-bus'
import type { SafetyRules, RuleVerdict, AgentAction, FileAction, ShellAction, NetworkAction } from './types'

// ─── Hard Engine ────────────────────────────────────────────

export class HardRulesEngine {
  private rules: SafetyRules
  private bus = getEventBus()
  private secretPattern: RegExp | null = null

  constructor() {
    this.rules = getRuleLoader().loadSafetyRules()
    this.compileSecretPattern()
  }

  /** Reload rules from disk (called when user edits config) */
  reload(): void {
    this.rules = getRuleLoader().loadSafetyRules()
    this.compileSecretPattern()
    this.bus.emitEvent('system:log', {
      level: 'info',
      message: 'Hard rules reloaded from config',
    })
  }

  /** Get current rules (for UI display) */
  getRules(): SafetyRules {
    return { ...this.rules }
  }

  /** Update rules and save to disk */
  updateRules(rules: SafetyRules): void {
    this.rules = rules
    getRuleLoader().saveSafetyRules(rules)
    this.compileSecretPattern()
  }

  // ─── Main Evaluation ──────────────────────────────────

  /**
   * Evaluate an agent action against safety rules.
   * Returns a verdict — allowed or blocked with reason.
   *
   * FAIL-CLOSED: any evaluation error results in DENIED.
   */
  evaluate(action: AgentAction): RuleVerdict {
    try {
      switch (action.type) {
        case 'file_read':
        case 'file_write':
        case 'file_delete':
        case 'file_move':
          return this.evaluateFileAction(action as FileAction)

        case 'shell_execute':
          return this.evaluateShellAction(action as ShellAction)

        case 'network_request':
          return this.evaluateNetworkAction(action as NetworkAction)

        default:
          // Unknown action type — fail closed
          return {
            allowed: false,
            reason: `Unknown action type: ${(action as AgentAction).type}`,
            category: 'unknown',
          }
      }
    } catch (err) {
      // Fail closed on any evaluation error
      const error = err instanceof Error ? err.message : String(err)
      this.bus.emitEvent('system:log', {
        level: 'error',
        message: `Hard rule evaluation error (action denied): ${error}`,
        data: { action },
      })

      return {
        allowed: false,
        reason: `Rule evaluation error (fail-closed): ${error}`,
        category: 'evaluation-error',
      }
    }
  }

  // ─── File Action Evaluation ───────────────────────────

  private evaluateFileAction(action: FileAction): RuleVerdict {
    const normPath = this.normalizePath(action.path)
    const rules = this.rules.filesystem

    // Check system blocked paths
    for (const blocked of rules.blocked_paths) {
      if (this.pathMatches(normPath, blocked)) {
        return {
          allowed: false,
          reason: `Path is blocked by system safety rule: ${blocked}`,
          rule: `blocked_path: ${blocked}`,
          category: 'filesystem',
        }
      }
    }

    // Check user-defined blocked paths
    const userBlocked = rules.user_blocked_paths ?? []
    for (const blocked of userBlocked) {
      if (this.pathMatches(normPath, blocked)) {
        return {
          allowed: false,
          reason: `Path is blocked by user-defined rule: ${blocked}`,
          rule: `user_blocked_path: ${blocked}`,
          category: 'filesystem',
        }
      }
    }

    // Check blocked extensions (for write operations)
    if (action.type === 'file_write') {
      const ext = this.getExtension(action.path)
      if (ext && rules.blocked_extensions.includes(ext.toLowerCase())) {
        return {
          allowed: false,
          reason: `File extension "${ext}" is blocked by safety rule`,
          rule: `blocked_extension: ${ext}`,
          category: 'filesystem',
        }
      }
    }

    // Check blocked operations — match against path and command-like content only,
    // NOT arbitrary file body text (to avoid false positives on words like "format")
    for (const op of rules.blocked_operations) {
      const pat = op.pattern.toLowerCase()
      if (action.path.toLowerCase().includes(pat)) {
        return {
          allowed: false,
          reason: op.reason ?? `Operation matches blocked pattern: ${op.pattern}`,
          rule: `blocked_operation: ${op.pattern}`,
          category: 'filesystem',
        }
      }
    }

    // Check file size limit (for writes)
    if (action.type === 'file_write' && action.size) {
      const sizeMB = action.size / (1024 * 1024)
      if (sizeMB > rules.max_file_size_mb) {
        return {
          allowed: false,
          reason: `File size (${sizeMB.toFixed(1)} MB) exceeds limit (${rules.max_file_size_mb} MB)`,
          rule: `max_file_size_mb: ${rules.max_file_size_mb}`,
          category: 'filesystem',
        }
      }
    }

    return { allowed: true, reason: 'File action permitted', category: 'filesystem' }
  }

  // ─── Shell Action Evaluation ──────────────────────────

  private evaluateShellAction(action: ShellAction): RuleVerdict {
    const rules = this.rules.shell

    // Shell completely disabled?
    if (!rules.allow_shell) {
      return {
        allowed: false,
        reason: 'Shell execution is disabled by safety rules',
        rule: 'allow_shell: false',
        category: 'shell',
      }
    }

    const command = action.command.toLowerCase().trim()
    const fullCommand = action.args
      ? `${action.command} ${action.args.join(' ')}`.toLowerCase()
      : command

    // Check blocked commands
    for (const blocked of rules.blocked_commands) {
      if (command.includes(blocked.toLowerCase()) || fullCommand.includes(blocked.toLowerCase())) {
        return {
          allowed: false,
          reason: `Command "${blocked}" is blocked by safety rules`,
          rule: `blocked_command: ${blocked}`,
          category: 'shell',
        }
      }
    }

    // Check blocked patterns
    for (const pattern of rules.blocked_patterns) {
      if (fullCommand.includes(pattern.pattern.toLowerCase())) {
        return {
          allowed: false,
          reason: pattern.reason ?? `Command matches blocked pattern: ${pattern.pattern}`,
          rule: `blocked_pattern: ${pattern.pattern}`,
          category: 'shell',
        }
      }
    }

    // Check timeout
    if (action.timeout && action.timeout > rules.max_execution_time_seconds * 1000) {
      return {
        allowed: false,
        reason: `Execution timeout (${action.timeout / 1000}s) exceeds limit (${rules.max_execution_time_seconds}s)`,
        rule: `max_execution_time_seconds: ${rules.max_execution_time_seconds}`,
        category: 'shell',
      }
    }

    return { allowed: true, reason: 'Shell action permitted', category: 'shell' }
  }

  // ─── Network Action Evaluation ────────────────────────

  private evaluateNetworkAction(action: NetworkAction): RuleVerdict {
    const rules = this.rules.network

    // Outbound disabled?
    if (!rules.allow_outbound) {
      return {
        allowed: false,
        reason: 'Outbound network requests are disabled by safety rules',
        rule: 'allow_outbound: false',
        category: 'network',
      }
    }

    // Check blocked domains
    try {
      const url = new URL(action.url)
      const domain = url.hostname.toLowerCase()

      for (const blocked of rules.blocked_domains) {
        if (domain === blocked.toLowerCase() || domain.endsWith(`.${blocked.toLowerCase()}`)) {
          return {
            allowed: false,
            reason: `Domain "${domain}" is blocked by safety rules`,
            rule: `blocked_domain: ${blocked}`,
            category: 'network',
          }
        }
      }
    } catch {
      return {
        allowed: false,
        reason: `Invalid URL: ${action.url}`,
        rule: 'url_validation',
        category: 'network',
      }
    }

    // Check request size
    if (action.bodySize) {
      const sizeMB = action.bodySize / (1024 * 1024)
      if (sizeMB > rules.max_request_size_mb) {
        return {
          allowed: false,
          reason: `Request size (${sizeMB.toFixed(1)} MB) exceeds limit (${rules.max_request_size_mb} MB)`,
          rule: `max_request_size_mb: ${rules.max_request_size_mb}`,
          category: 'network',
        }
      }
    }

    return { allowed: true, reason: 'Network action permitted', category: 'network' }
  }

  // ─── Secret Redaction ─────────────────────────────────

  /** Redact secrets from text before logging or storing in memory */
  redactSecrets(text: string): string {
    let result = text

    // Check each never_log keyword
    for (const keyword of this.rules.secrets.never_log) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = '(' + escaped + '\\s*[:=]\\s*["\']?)([^"\'\\s]{4,})'
      const regex = new RegExp(pattern, 'gi')
      result = result.replace(regex, '$1[REDACTED]')
    }

    // Apply compiled secret pattern
    if (this.secretPattern) {
      result = result.replace(this.secretPattern, (match, prefix) => {
        return `${prefix}[REDACTED]`
      })
    }

    return result
  }

  /** Check if content should be stored in memory (secret safety check) */
  shouldStoreInMemory(content: string): boolean {
    if (!this.rules.secrets.never_include_in_memory) return true

    const lowerContent = content.toLowerCase()
    for (const keyword of this.rules.secrets.never_log) {
      if (lowerContent.includes(keyword.toLowerCase())) {
        return false
      }
    }

    return true
  }

  // ─── Helpers ──────────────────────────────────────────

  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase()
  }

  private getExtension(p: string): string | null {
    const dot = p.lastIndexOf('.')
    return dot >= 0 ? p.slice(dot) : null
  }

  /**
   * Simple glob matching for path rules.
   * Supports ** (recursive) and * (single level).
   */
  private pathMatches(path: string, pattern: string): boolean {
    const normPattern = pattern.replace(/\\/g, '/').toLowerCase()

    // Convert glob to regex
    const regexStr = normPattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // escape regex specials
      .replace(/\\\*\\\*/g, '.*')               // ** → .*
      .replace(/\\\*/g, '[^/]*')                 // * → [^/]*

    try {
      const regex = new RegExp(`^${regexStr}`)
      return regex.test(path)
    } catch {
      // If pattern is invalid, use simple startsWith
      return path.startsWith(normPattern.replace(/\*\*/g, '').replace(/\*/g, ''))
    }
  }

  private compileSecretPattern(): void {
    try {
      if (this.rules.secrets.redaction_pattern) {
        this.secretPattern = new RegExp(this.rules.secrets.redaction_pattern, 'gi')
      }
    } catch {
      this.secretPattern = null
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: HardRulesEngine | null = null

export function getHardEngine(): HardRulesEngine {
  if (!instance) {
    instance = new HardRulesEngine()
  }
  return instance
}
