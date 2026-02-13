/**
 * Rules Engine — Shared types for Hard + Soft rule systems
 */
import type { AgentType } from '../agents/event-bus'

// ─── Rule Verdict ───────────────────────────────────────────

export interface RuleVerdict {
  allowed: boolean
  reason: string
  rule?: string        // which rule triggered
  category?: string    // e.g. 'filesystem', 'shell', 'network'
}

// ─── Safety Rules (Hard Engine) ─────────────────────────────

export interface SafetyRules {
  filesystem: {
    blocked_paths: string[]
    blocked_extensions: string[]
    blocked_operations: Array<{ pattern: string; reason?: string }>
    max_file_size_mb: number
    max_files_per_operation: number
  }
  shell: {
    blocked_commands: string[]
    blocked_patterns: Array<{ pattern: string; reason?: string }>
    max_execution_time_seconds: number
    allow_shell: boolean
  }
  network: {
    blocked_domains: string[]
    max_request_size_mb: number
    allow_outbound: boolean
  }
  secrets: {
    never_log: string[]
    never_include_in_memory: boolean
    redaction_pattern: string  // regex pattern for auto-redaction
  }
}

// ─── Behavioral Rules (Soft Engine) ─────────────────────────

export interface BehavioralRule {
  rule: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  enabled: boolean
}

export interface QualityRule {
  rule: string
  applies_to: AgentType[]
  context?: string  // e.g. 'backend', 'frontend', 'research'
  enabled: boolean
}

export interface RoutingRule {
  when: string
  action: string
  enabled: boolean
}

export interface MemoryRules {
  always_remember: string[]
  never_remember: string[]
  ask_before_remembering: string[]
}

export interface EscalationRule {
  when: string
  action: 'ask_user' | 'warn_user' | 'block'
  message?: string
  enabled: boolean
}

export interface CostRules {
  rules: Array<{ when: string; action: string; enabled: boolean }>
  monthly_budget_alert: number
  prefer_cheap_for: string[]  // task complexities that should use cheap models
}

export interface BehaviorRules {
  behavioral: BehavioralRule[]
  quality: {
    code: QualityRule[]
    research: QualityRule[]
    general: QualityRule[]
  }
  routing: RoutingRule[]
  memory: MemoryRules
  escalation: EscalationRule[]
  cost: CostRules
}

// ─── Rule Proposal (Reflection → User) ─────────────────────

export interface RuleProposal {
  id: string
  suggestedRule: string
  category: 'behavioral' | 'quality' | 'routing' | 'memory' | 'escalation' | 'cost'
  evidence: string[]         // Episode IDs that triggered this suggestion
  confidence: number         // 0-1
  appliesTo?: AgentType[]
  createdAt: number
  status: 'pending' | 'accepted' | 'dismissed'
}

// ─── Action Descriptors (what agents want to do) ────────

export interface FileAction {
  type: 'file_read' | 'file_write' | 'file_delete' | 'file_move'
  path: string
  content?: string
  size?: number // bytes
}

export interface ShellAction {
  type: 'shell_execute'
  command: string
  args?: string[]
  cwd?: string
  timeout?: number
}

export interface NetworkAction {
  type: 'network_request'
  url: string
  method: string
  bodySize?: number // bytes
}

export type AgentAction = FileAction | ShellAction | NetworkAction
