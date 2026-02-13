/**
 * Soft Rules Engine — Behavioral Governor
 *
 * Prompt-injected rules that guide agent behavior, quality, routing,
 * memory, escalation, and cost optimization. Unlike hard rules,
 * these are advisory — they shape LLM prompts rather than blocking actions.
 *
 * Rules are scoped by agent type and task context.
 */
import { getRuleLoader } from './rule-loader'
import { getEventBus, type AgentType } from '../agents/event-bus'
import type { BehaviorRules, EscalationRule, RuleProposal } from './types'
import { randomUUID } from 'crypto'

// ─── Escalation Check Result ────────────────────────────────

export interface EscalationCheckResult {
  shouldEscalate: boolean
  action: 'ask_user' | 'warn_user' | 'block'
  message: string
  rule: string
}

// ─── Soft Engine ────────────────────────────────────────────

export class SoftRulesEngine {
  private rules: BehaviorRules
  private bus = getEventBus()
  private pendingProposals = new Map<string, RuleProposal>()

  constructor() {
    this.rules = getRuleLoader().loadBehaviorRules()
  }

  /** Reload rules from disk */
  reload(): void {
    this.rules = getRuleLoader().loadBehaviorRules()
    this.bus.emitEvent('system:log', {
      level: 'info',
      message: 'Soft rules reloaded from config',
    })
  }

  /** Get current rules (for UI display) */
  getRules(): BehaviorRules {
    return { ...this.rules }
  }

  /** Update rules and save to disk */
  updateRules(rules: BehaviorRules): void {
    this.rules = rules
    getRuleLoader().saveBehaviorRules(rules)
  }

  // ─── Rules for Agent Prompts ──────────────────────────

  /**
   * Get all applicable rules for an agent, formatted for prompt injection.
   * Returns an array of rule strings to inject into the system prompt.
   */
  getRulesForAgent(
    agentType: AgentType,
    taskContext?: string
  ): string[] {
    const rules: string[] = []

    // 1. Behavioral rules (apply to all agents)
    for (const rule of this.rules.behavioral) {
      if (rule.enabled) {
        rules.push(`[${rule.priority.toUpperCase()}] ${rule.rule}`)
      }
    }

    // 2. Quality rules — code
    for (const rule of this.rules.quality.code) {
      if (rule.enabled && rule.applies_to.includes(agentType)) {
        if (!rule.context || rule.context === taskContext) {
          rules.push(`[QUALITY] ${rule.rule}`)
        }
      }
    }

    // 3. Quality rules — research
    for (const rule of this.rules.quality.research) {
      if (rule.enabled && rule.applies_to.includes(agentType)) {
        rules.push(`[QUALITY] ${rule.rule}`)
      }
    }

    // 4. Quality rules — general
    for (const rule of this.rules.quality.general) {
      if (rule.enabled && rule.applies_to.includes(agentType)) {
        rules.push(`[QUALITY] ${rule.rule}`)
      }
    }

    // 5. Memory rules (for memory-related agents or orchestrator)
    if (agentType === 'orchestrator' || agentType === 'memory' || agentType === 'reflection') {
      const memRules = this.rules.memory
      if (memRules.always_remember.length > 0) {
        rules.push(`[MEMORY] Always remember: ${memRules.always_remember.join('; ')}`)
      }
      if (memRules.never_remember.length > 0) {
        rules.push(`[MEMORY] Never remember: ${memRules.never_remember.join('; ')}`)
      }
      if (memRules.ask_before_remembering.length > 0) {
        rules.push(`[MEMORY] Ask user before remembering: ${memRules.ask_before_remembering.join('; ')}`)
      }
    }

    return rules
  }

  /**
   * Build a formatted constraint block for injection into agent system prompts.
   */
  buildConstraintBlock(agentType: AgentType, taskContext?: string): string {
    const rules = this.getRulesForAgent(agentType, taskContext)

    if (rules.length === 0) return ''

    return [
      '',
      '═══ CONSTRAINTS ═══',
      'You MUST follow these rules:',
      ...rules.map((r, i) => `${i + 1}. ${r}`),
      '═══════════════════',
      '',
    ].join('\n')
  }

  // ─── Routing ──────────────────────────────────────────

  /**
   * Get routing suggestions for a task.
   * Returns action strings that the Orchestrator should consider.
   */
  getRoutingSuggestions(taskDescription: string): string[] {
    const suggestions: string[] = []
    const lowerTask = taskDescription.toLowerCase()

    for (const route of this.rules.routing) {
      if (!route.enabled) continue

      // Simple keyword matching on the "when" condition
      const keywords = route.when.toLowerCase().split(/\s+/)
      const matchRatio = keywords.filter((kw) => lowerTask.includes(kw)).length / keywords.length

      if (matchRatio > 0.5) {
        suggestions.push(route.action)
      }
    }

    return suggestions
  }

  // ─── Escalation ───────────────────────────────────────

  /**
   * Check if the current situation requires escalation to the user.
   * Called by the Orchestrator before/during task execution.
   */
  checkEscalation(context: {
    confidence?: number
    isDestructive?: boolean
    estimatedCost?: number
    touchesExternalFiles?: boolean
    taskDescription?: string
  }): EscalationCheckResult | null {
    for (const rule of this.rules.escalation) {
      if (!rule.enabled) continue

      const match = this.evaluateEscalationCondition(rule, context)
      if (match) {
        return {
          shouldEscalate: true,
          action: rule.action,
          message: rule.message ?? `Escalation triggered: ${rule.when}`,
          rule: rule.when,
        }
      }
    }

    return null
  }

  private evaluateEscalationCondition(
    rule: EscalationRule,
    ctx: {
      confidence?: number
      isDestructive?: boolean
      estimatedCost?: number
      touchesExternalFiles?: boolean
    }
  ): boolean {
    const condition = rule.when.toLowerCase()

    // Confidence threshold
    const confMatch = condition.match(/confidence\s*<\s*([\d.]+)/)
    if (confMatch && ctx.confidence !== undefined) {
      return ctx.confidence < parseFloat(confMatch[1])
    }

    // Destructive actions
    if (condition.includes('destructive') && ctx.isDestructive) {
      return true
    }

    // Cost threshold
    const costMatch = condition.match(/cost\s*exceeds?\s*\$?([\d.]+)/)
    if (costMatch && ctx.estimatedCost !== undefined) {
      return ctx.estimatedCost > parseFloat(costMatch[1])
    }

    // External files
    if (condition.includes('outside workspace') && ctx.touchesExternalFiles) {
      return true
    }

    return false
  }

  // ─── Cost Optimization ────────────────────────────────

  /**
   * Should we prefer a cheaper model for this task?
   */
  shouldUseCheapModel(complexity: string): boolean {
    return this.rules.cost.prefer_cheap_for.includes(complexity.toLowerCase())
  }

  /**
   * Get the monthly budget alert threshold.
   */
  getMonthlyBudgetAlert(): number {
    return this.rules.cost.monthly_budget_alert
  }

  // ─── Memory Rules ─────────────────────────────────────

  /**
   * Check if content should be remembered based on memory rules.
   */
  shouldRemember(content: string): 'yes' | 'no' | 'ask' {
    const lower = content.toLowerCase()

    // Check never_remember first (highest priority)
    for (const pattern of this.rules.memory.never_remember) {
      if (lower.includes(pattern.toLowerCase())) {
        return 'no'
      }
    }

    // Check ask_before_remembering
    for (const pattern of this.rules.memory.ask_before_remembering) {
      if (lower.includes(pattern.toLowerCase())) {
        return 'ask'
      }
    }

    return 'yes'
  }

  // ─── Rule Proposals ───────────────────────────────────

  /**
   * Submit a rule proposal (typically from the Reflection agent).
   * The proposal is stored and an event is emitted for the UI.
   */
  proposeRule(proposal: Omit<RuleProposal, 'id' | 'createdAt' | 'status'>): RuleProposal {
    const fullProposal: RuleProposal = {
      ...proposal,
      id: randomUUID(),
      createdAt: Date.now(),
      status: 'pending',
    }

    this.pendingProposals.set(fullProposal.id, fullProposal)

    this.bus.emitEvent('system:log', {
      level: 'info',
      message: `Rule proposal: "${proposal.suggestedRule}" (confidence: ${proposal.confidence})`,
      data: fullProposal,
    })

    return fullProposal
  }

  /** Accept a pending rule proposal — add it to behavior rules */
  acceptProposal(proposalId: string): boolean {
    const proposal = this.pendingProposals.get(proposalId)
    if (!proposal || proposal.status !== 'pending') return false

    proposal.status = 'accepted'

    // Add to the appropriate category
    switch (proposal.category) {
      case 'behavioral':
        this.rules.behavioral.push({
          rule: proposal.suggestedRule,
          priority: 'medium',
          enabled: true,
        })
        break

      case 'quality':
        this.rules.quality.general.push({
          rule: proposal.suggestedRule,
          applies_to: proposal.appliesTo ?? ['orchestrator'],
          enabled: true,
        })
        break

      case 'routing':
        this.rules.routing.push({
          when: proposal.suggestedRule.split('→')[0]?.trim() ?? proposal.suggestedRule,
          action: proposal.suggestedRule.split('→')[1]?.trim() ?? 'consider this rule',
          enabled: true,
        })
        break

      case 'escalation':
        this.rules.escalation.push({
          when: proposal.suggestedRule,
          action: 'ask_user',
          enabled: true,
        })
        break

      default:
        // Add as behavioral catch-all
        this.rules.behavioral.push({
          rule: proposal.suggestedRule,
          priority: 'medium',
          enabled: true,
        })
    }

    // Persist to disk
    getRuleLoader().saveBehaviorRules(this.rules)

    this.bus.emitEvent('system:log', {
      level: 'info',
      message: `Rule proposal accepted: "${proposal.suggestedRule}"`,
    })

    return true
  }

  /** Dismiss a pending proposal */
  dismissProposal(proposalId: string): boolean {
    const proposal = this.pendingProposals.get(proposalId)
    if (!proposal || proposal.status !== 'pending') return false

    proposal.status = 'dismissed'

    this.bus.emitEvent('system:log', {
      level: 'info',
      message: `Rule proposal dismissed: "${proposal.suggestedRule}"`,
    })

    return true
  }

  /** Get all pending proposals */
  getPendingProposals(): RuleProposal[] {
    return [...this.pendingProposals.values()].filter((p) => p.status === 'pending')
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: SoftRulesEngine | null = null

export function getSoftEngine(): SoftRulesEngine {
  if (!instance) {
    instance = new SoftRulesEngine()
  }
  return instance
}
