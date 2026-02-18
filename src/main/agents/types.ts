/**
 * Agent Types — Shared type definitions for the agent framework
 *
 * Extracted from base-agent.ts to decouple type definitions from the
 * BaseAgent implementation. All agent subclasses and external consumers
 * can import these types without pulling in the full BaseAgent class.
 */
import type { AgentType, EventBus } from './event-bus'
import type { ImageAttachment } from '@shared/types'
import type { BlackboardHandle } from './blackboard'
import type { DelegationContext } from './delegation'
import type { CancellationToken } from './cancellation'
import type { ApprovalSettings } from '../tools/approval'

// ─── Task Types ─────────────────────────────────────────────

export interface SubTask {
    id: string
    description: string
    assignedAgent: AgentType
    status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'retrying'
    dependencies: string[] // IDs of tasks that must complete first
    result?: unknown
    error?: string
    attempts: number
    maxAttempts: number
}

export interface TaskPlan {
    id: string
    taskId: string
    originalTask: string
    subTasks: SubTask[]
    estimatedComplexity: 'trivial' | 'simple' | 'moderate' | 'complex' | 'epic'
    requiredAgents: AgentType[]
}

export interface ToolingNeeds {
    webSearch?: boolean
    fileSystem?: boolean
    shellCommand?: boolean
    httpRequest?: boolean
}

// ─── Agent Context & Result ─────────────────────────────────

export interface AgentContext {
    taskId: string
    planId?: string
    parentTask?: string
    relevantMemories?: string[]
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
    siblingResults?: Map<string, AgentResult>
    images?: ImageAttachment[]
    blackboard?: BlackboardHandle
    /** Injected by AgentPool — allows agents to spawn sub-agents */
    delegateFn?: (agentType: AgentType, task: string) => Promise<AgentResult>
    /** Injected by AgentPool — allows agents to spawn multiple sub-agents in parallel */
    parallelDelegateFn?: (tasks: Array<{ agent: AgentType; task: string }>) => Promise<AgentResult[]>
    /** Current delegation depth (0 = top-level, incremented per delegation) */
    delegationDepth?: number
    /** Context from parent agent (Boomerang pattern) */
    delegationContext?: DelegationContext
    /** Tooling needs from triage — tells agents what capabilities to use */
    toolingNeeds?: ToolingNeeds
    /** Cancellation token — checked every iteration to support user abort */
    cancellationToken?: CancellationToken
    /** Resolved working directory for this task (defaults to detectWorkspace() result) */
    workDir?: string
    /** Active mode slug — when set, tool filtering uses mode-based rules instead of agent defaults */
    mode?: string
}

export interface AgentResult {
    status: 'success' | 'partial' | 'failed'
    output: unknown
    confidence: number // 0.0 to 1.0
    reasoning?: string
    tokensIn: number
    tokensOut: number
    model: string
    promptVersion?: string // e.g. "v1:a4f2c9e1"
    suggestedMemories?: SuggestedMemory[]
    artifacts?: Artifact[]
    error?: string
    duration: number // ms
}

export interface SuggestedMemory {
    type: 'episodic' | 'semantic' | 'procedural'
    content: string
    importance: number
    tags: string[]
}

export interface Artifact {
    type: 'code' | 'text' | 'json' | 'file'
    name: string
    content: string
    language?: string
}

// ─── BaseAgent Context Interface ────────────────────────────
//
// Extracted runner functions (native-tool-runner, xml-tool-runner, etc.)
// accept this interface instead of the full BaseAgent class.
// This avoids circular imports: runners → interface (here), class → runners.

export interface BaseAgentHandle {
    readonly type: AgentType
    readonly bus: EventBus
    getApprovalSettings(): ApprovalSettings
    getBrainwaveHomeDir(): string
    getSystemPrompt(context: AgentContext): string | Promise<string>
}
