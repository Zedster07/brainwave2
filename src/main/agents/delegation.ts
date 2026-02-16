/**
 * Agent-to-Agent Delegation
 *
 * Defines which agents can delegate work to other agents and under
 * what constraints. During their tool loop, agents can call the virtual
 * `delegate_to_agent` tool to spawn a sub-agent (serial) or `use_subagents`
 * to spawn multiple sub-agents in parallel (up to 5 concurrent).
 *
 * Design:
 *   - delegateFn / parallelDelegateFn are injected into AgentContext by AgentPool.run()
 *   - BaseAgent.executeWithTools() recognises both delegation tool calls
 *   - Depth is limited to prevent A→B→A→… infinite chains
 *   - Blackboard is shared so delegated agents see the same context
 *   - Boomerang pattern: parent awaits children, results injected back into conversation
 */

import type { AgentType } from './event-bus'

// ─── Config ─────────────────────────────────────────────────

/** Default maximum delegation depth (0 = the original agent, 1 = one level of sub-agents, etc.) */
const DEFAULT_MAX_DELEGATION_DEPTH = 2

/** Current configurable depth — can be changed at runtime via setMaxDelegationDepth() */
let maxDelegationDepth = DEFAULT_MAX_DELEGATION_DEPTH

/** Maximum number of parallel sub-agents in a single use_subagents call */
export const MAX_PARALLEL_SUBAGENTS = 5

/** Get the current max delegation depth */
export function getMaxDelegationDepth(): number {
  return maxDelegationDepth
}

/** Set the max delegation depth at runtime */
export function setMaxDelegationDepth(depth: number): void {
  maxDelegationDepth = Math.max(1, Math.min(depth, 5))
  console.log(`[Delegation] Max depth set to ${maxDelegationDepth}`)
}

// Keep backward-compatible constant (reads from configurable value)
export const MAX_DELEGATION_DEPTH = DEFAULT_MAX_DELEGATION_DEPTH

/** Which agent types each agent is allowed to delegate to */
const DELEGATION_RULES: Partial<Record<AgentType, AgentType[]>> = {
  // Executor can delegate to any specialist
  executor: ['researcher', 'coder', 'reviewer', 'writer', 'analyst', 'critic'],

  // Coder can ask for research or code review
  coder: ['researcher', 'reviewer'],

  // Researcher can ask coder to read/analyse code
  researcher: ['coder'],

  // Reviewer can ask researcher to fact-check or coder to inspect code
  reviewer: ['researcher', 'coder'],

  // Analyst can ask researcher for data gathering
  analyst: ['researcher'],

  // Critics and other pure-reasoning agents cannot delegate
}

// ─── Public API ─────────────────────────────────────────────

/** Check whether `delegator` is allowed to delegate to `target` */
export function canDelegate(delegator: AgentType, target: AgentType): { allowed: boolean; reason?: string } {
  const allowed = DELEGATION_RULES[delegator]
  if (!allowed) {
    return { allowed: false, reason: `Agent "${delegator}" is not permitted to delegate to other agents` }
  }
  if (!allowed.includes(target)) {
    return {
      allowed: false,
      reason: `Agent "${delegator}" cannot delegate to "${target}". Allowed targets: ${allowed.join(', ')}`,
    }
  }
  // Self-delegation is never allowed
  if (delegator === target) {
    return { allowed: false, reason: `Agent "${delegator}" cannot delegate to itself` }
  }
  return { allowed: true }
}

/** Get the list of agent types that `delegator` can delegate to */
export function getDelegationTargets(delegator: AgentType): AgentType[] {
  return DELEGATION_RULES[delegator] ?? []
}

/** Check whether delegation is possible at this depth */
export function canDelegateAtDepth(currentDepth: number): boolean {
  return currentDepth < maxDelegationDepth
}

/**
 * Build a tool-catalog entry for the delegation tool.
 * Included in the tool section when the agent has delegation targets.
 */
export function buildDelegationToolDescription(delegator: AgentType): string | null {
  const targets = getDelegationTargets(delegator)
  if (targets.length === 0) return null

  const targetDescriptions: Record<string, string> = {
    researcher: 'web search, fact-finding, data gathering',
    coder: 'code reading, writing, analysis',
    reviewer: 'code review, quality checks',
    writer: 'drafting text, documentation, creative writing',
    analyst: 'data analysis, pattern recognition',
    critic: 'critical evaluation, argument analysis',
    executor: 'full system access, shell commands',
  }

  const targetList = targets
    .map((t) => `    - "${t}": ${targetDescriptions[t] ?? t}`)
    .join('\n')

  return (
    `  delegate_to_agent:\n` +
    `    Delegate a sub-task to another specialist agent and get their result.\n` +
    `    Use this when the task requires expertise outside your specialty.\n` +
    `    Available agents:\n${targetList}\n` +
    `    Args: { "agent": "<agent_type>", "task": "<detailed task description>" }\n` +
    `    Example: { "tool": "delegate_to_agent", "args": { "agent": "researcher", "task": "Find the latest React 19 migration guide" } }`
  )
}

// ─── Parallel Delegation (use_subagents) ────────────────────

/** Context passed from parent to child during delegation (Boomerang pattern) */
export interface DelegationContext {
  /** ID of the parent task that spawned this delegation */
  parentTaskId: string
  /** Summary of what the parent has done so far */
  parentSummary: string
  /** Files the parent has already read (so child can skip re-reading) */
  relevantFiles: string[]
  /** Specific instructions from the parent to the child */
  specificInstructions: string
}

/**
 * Build a tool-catalog entry for the parallel delegation tool.
 * Only shown when the agent has delegation targets and delegation depth allows it.
 */
export function buildParallelDelegationToolDescription(delegator: AgentType): string | null {
  const targets = getDelegationTargets(delegator)
  if (targets.length === 0) return null

  const targetDescriptions: Record<string, string> = {
    researcher: 'web search, fact-finding, data gathering',
    coder: 'code reading, writing, analysis',
    reviewer: 'code review, quality checks',
    writer: 'drafting text, documentation, creative writing',
    analyst: 'data analysis, pattern recognition',
    critic: 'critical evaluation, argument analysis',
    executor: 'full system access, shell commands',
  }

  const targetList = targets
    .map((t) => `    - "${t}": ${targetDescriptions[t] ?? t}`)
    .join('\n')

  return (
    `  use_subagents:\n` +
    `    Run multiple sub-tasks in PARALLEL (up to ${MAX_PARALLEL_SUBAGENTS}).\n` +
    `    Each task runs on its own agent concurrently — use for independent work.\n` +
    `    Available agents:\n${targetList}\n` +
    `    Returns results from all sub-agents when all complete.\n` +
    `    Only use when tasks are truly independent (no dependencies between them).`
  )
}
