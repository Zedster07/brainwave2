/**
 * Event Bus — Typed pub/sub for agent-to-agent and system communication
 *
 * All inter-component communication flows through this bus.
 * Events are logged for the Agent Monitor UI and debugging.
 */
import { EventEmitter } from 'events'

// ─── Event Types ────────────────────────────────────────────

export type AgentType =
  | 'orchestrator'
  | 'planner'
  | 'researcher'
  | 'coder'
  | 'reviewer'
  | 'file'
  | 'memory'
  | 'reflection'
  | 'scheduler'
  | 'communication'

export interface AgentMessage {
  id: string
  from: AgentType | 'system' | 'user'
  to: AgentType | 'system' | 'broadcast'
  type: MessageType
  payload: unknown
  context: {
    taskId: string
    planId?: string
  }
  metadata: {
    timestamp: number
    confidence?: number
    priority: 'low' | 'medium' | 'high' | 'critical'
    tokensUsed?: number
  }
}

export type MessageType =
  | 'task-assignment'
  | 'task-result'
  | 'task-progress'
  | 'clarification'
  | 'status-update'
  | 'error-report'
  | 'memory-request'
  | 'memory-response'
  | 'review-request'
  | 'review-response'
  | 'plan-created'
  | 'plan-updated'
  | 'agent-spawned'
  | 'agent-completed'

export interface EventMap {
  // Task lifecycle
  'task:submitted': { taskId: string; prompt: string; priority: string }
  'task:planning': { taskId: string }
  'task:executing': { taskId: string; step: string }
  'task:progress': { taskId: string; progress: number; currentStep: string }
  'task:completed': { taskId: string; result: unknown }
  'task:failed': { taskId: string; error: string }
  'task:cancelled': { taskId: string }

  // Agent lifecycle
  'agent:thinking': { agentType: AgentType; taskId: string; model: string }
  'agent:acting': { agentType: AgentType; taskId: string; action: string }
  'agent:completed': { agentType: AgentType; taskId: string; confidence: number; tokensIn: number; tokensOut: number }
  'agent:error': { agentType: AgentType; taskId: string; error: string }
  'agent:idle': { agentType: AgentType }

  // Agent messages
  'agent:message': AgentMessage

  // Plan
  'plan:created': { taskId: string; planId: string; steps: number; agents: AgentType[] }
  'plan:step-completed': { taskId: string; planId: string; stepId: string; agentType: AgentType }
  'plan:step-failed': { taskId: string; planId: string; stepId: string; error: string }

  // System
  'system:log': { level: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown }
  'system:error': { error: string; fatal: boolean }
}

// ─── Event Log Entry ────────────────────────────────────────

export interface EventLogEntry {
  id: string
  event: string
  data: unknown
  timestamp: number
}

// ─── Event Bus ──────────────────────────────────────────────

let idCounter = 0
function nextId(): string {
  return `evt_${Date.now()}_${++idCounter}`
}

class EventBusClass extends EventEmitter {
  private log: EventLogEntry[] = []
  private maxLogSize = 1000

  constructor() {
    super()
    this.setMaxListeners(50)
  }

  /** Emit a typed event */
  emitEvent<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    const entry: EventLogEntry = {
      id: nextId(),
      event,
      data,
      timestamp: Date.now(),
    }

    // Append to rolling log
    this.log.push(entry)
    if (this.log.length > this.maxLogSize) {
      this.log = this.log.slice(-this.maxLogSize)
    }

    this.emit(event, data)
  }

  /** Listen for a typed event */
  onEvent<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): () => void {
    this.on(event, handler)
    return () => this.off(event, handler)
  }

  /** Listen once for a typed event */
  onceEvent<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void {
    this.once(event, handler)
  }

  /** Get the full event log (for Agent Monitor UI) */
  getLog(limit?: number): EventLogEntry[] {
    if (limit) {
      return this.log.slice(-limit)
    }
    return [...this.log]
  }

  /** Get events of a specific type */
  getLogByEvent(event: keyof EventMap, limit = 50): EventLogEntry[] {
    return this.log
      .filter((e) => e.event === event)
      .slice(-limit)
  }

  /** Clear the log */
  clearLog(): void {
    this.log = []
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: EventBusClass | null = null

export function getEventBus(): EventBusClass {
  if (!instance) {
    instance = new EventBusClass()
  }
  return instance
}

export type EventBus = EventBusClass
