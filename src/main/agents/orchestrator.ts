/**
 * Orchestrator Agent — The CEO of the agent system
 *
 * Receives user tasks, consults memory, delegates to Planner,
 * executes the plan via the Agent Pool, compiles results.
 *
 * Flow: User Task → Triage → (Direct Reply | Single Agent | Full Pipeline)
 *
 * Triage classifies prompts into 3 lanes:
 * - conversational: greetings, small talk → instant reply (no agents)
 * - direct: single-agent tasks → skip planner, go straight to the right agent
 * - complex: multi-step work → full planner → DAG → reflection
 */
import { randomUUID } from 'crypto'
import { BaseAgent, type AgentContext, type AgentResult, type SubTask, type TaskPlan } from './base-agent'
import { PlannerAgent } from './planner'
import { getEventBus, type AgentType } from './event-bus'
import { getDatabase } from '../db/database'
import { getMemoryManager } from '../memory'
import { getWorkingMemory } from '../memory/working-memory'
import { LLMFactory } from '../llm/factory'
import { getPeopleStore } from '../memory/people'
import { getProspectiveStore } from '../memory/prospective'
import { ReflectionAgent } from './reflection'
import { getSoftEngine } from '../rules'
import { getPromptRegistry } from '../prompts'
import { getMcpRegistry } from '../mcp'
import type { ImageAttachment } from '@shared/types'

// ─── Task Record (stored in DB) ────────────────────────────

export interface TaskRecord {
  id: string
  prompt: string
  priority: 'low' | 'normal' | 'high'
  status: 'pending' | 'planning' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
  plan?: TaskPlan
  result?: unknown
  error?: string
  createdAt: number
  completedAt?: number
  images?: ImageAttachment[]
}

// ─── Triage Classification ─────────────────────────────────

type TriageLane = 'conversational' | 'direct' | 'complex'

interface TriageResult {
  lane: TriageLane
  reply?: string          // only for conversational
  agent?: AgentType       // only for direct
  shouldRemember?: boolean // whether this interaction is worth storing in memory
  personInfo?: {           // extracted person data — auto-creates/updates People entries
    name: string
    nickname?: string
    fullName?: string
    relationship?: string
    email?: string
    phone?: string
    address?: string
    birthday?: string
    age?: number
    gender?: string
    occupation?: string
    company?: string
    socialLinks?: Record<string, string>
    notes?: string
    traits?: string[]
    preferences?: Record<string, string>
  }
  semanticFacts?: Array<{  // extracted facts/preferences — stored as semantic memory
    subject: string
    predicate: string
    object: string
  }>
  toolingNeeds?: {          // what real-world capabilities the task requires
    webSearch?: boolean      // needs live internet data or web search
    fileSystem?: boolean     // needs to read/write/create files on disk
    shellCommand?: boolean   // needs to execute terminal commands
    httpRequest?: boolean    // needs to call external APIs
  }
  reminder?: {             // extracted intention/reminder — stored as prospective memory
    intention: string
    triggerType: 'time' | 'event' | 'condition'
    triggerValue: string
    priority?: number
  }
  reasoning: string
}

// ─── Orchestrator ───────────────────────────────────────────

export class Orchestrator extends BaseAgent {
  readonly type = 'orchestrator' as const
  readonly capabilities = ['planning', 'delegation', 'monitoring', 'decision-making']
  readonly description = 'Central intelligence — receives tasks, creates plans, delegates, monitors'

  private planner = new PlannerAgent()
  private reflector = new ReflectionAgent()
  private activeTasks = new Map<string, TaskRecord>()
  private agentExecutor: AgentExecutorFn | null = null

  /** Build a concise summary of connected MCP servers + local tools for prompt injection */
  private getMcpSummary(): string {
    try {
      const registry = getMcpRegistry()
      const statuses = registry.getStatuses()
      const allTools = registry.getAllTools()
      const connected = statuses.filter((s) => s.state === 'connected')
      const failed = statuses.filter((s) => s.state === 'error')
      if (connected.length === 0 && failed.length === 0) return '\nMCP Servers: None configured.'
      let summary = `\nMCP SERVERS (${connected.length} connected, ${failed.length} failed):`
      for (const s of connected) {
        const serverTools = allTools.filter((t) => t.serverName === s.name || t.serverId === s.id)
        const toolNames = serverTools.map((t) => t.name).join(', ')
        summary += `\n- ${s.name} — CONNECTED (${s.toolCount} tools: ${toolNames || 'none listed'})`
      }
      for (const s of failed) {
        summary += `\n- ${s.name} — FAILED: ${s.error ?? 'unknown error'}`
      }
      const disconnected = statuses.filter((s) => s.state === 'disconnected')
      if (disconnected.length > 0) {
        summary += `\n- ${disconnected.length} more server(s) configured but not connected`
      }
      summary += '\n\nLocal built-in tools: file_read, file_write, file_create, file_delete, file_move, directory_list, shell_execute, http_request, web_search, webpage_fetch, send_notification'
      return summary
    } catch {
      return '\nMCP Servers: Unable to query status.'
    }
  }

  protected getSystemPrompt(_context: AgentContext): string {
    return `You are the Orchestrator — the central intelligence of the Brainwave system.

Your responsibilities:
1. Analyze incoming tasks to understand their nature and complexity
2. Decide the best approach to solve the task
3. Coordinate the execution of sub-tasks
4. Compile final results for the user
5. Report confidence and reasoning transparently

IMPORTANT — SYSTEM CAPABILITIES:
You have ALMOST FULL ACCESS to the user's computer through the Executor agent.
All actions are gated by safety rules to protect the OS, but within those limits you CAN:
- Read, write, create, delete, move, and rename files anywhere (except protected OS directories)
- List directory contents
- Execute shell commands (cmd, PowerShell, sh, bash, git, npm, python, etc.)
- Make HTTP/network requests (fetch APIs, download data, etc.)
- Interact with any user-accessible file or program

You MUST NEVER tell the user "I can't access your file system" or "I don't have the ability to..." —
you DO have these abilities via the executor agent. Route filesystem/shell/network tasks there.

You have access to these specialist agents:
- Planner: Decomposes tasks into sub-tasks
- Researcher: Searches the web, reads docs, finds answers
- Coder: Writes, modifies, and explains code
- Reviewer: Quality checks all outputs
- Reflection: Learns from completed tasks
- Executor: FULL LOCAL ACCESS — reads/writes/creates/deletes files, lists directories, executes shell commands, makes HTTP requests

Decision framework:
- Conversational prompts (greetings, small talk, simple questions) → reply directly
- Single-agent tasks → delegate without planning overhead
- Complex multi-step tasks → use Planner to decompose into sub-tasks

MANDATORY — CONTEXT-FIRST PROTOCOL (follow this BEFORE every task):
1. UNDERSTAND FIRST: Before answering or delegating ANY task, make sure you have
   full context about what the user is asking. If the request is ambiguous, ask
   a clarifying question instead of guessing.
2. CHECK MEMORY: If you think you're missing context (user preferences, project details,
   prior decisions, file paths, etc.), check the RELEVANT MEMORIES provided to you.
   Past interactions often contain the missing pieces.
3. ENRICH WITH TOOLS: If context is still insufficient, think about which tools can
   help you gather what you need BEFORE starting implementation:
   - Use the Executor's web_search tool to find current information online
   - Use the Executor's webpage_fetch tool to read specific URLs or documentation
   - Use the Executor's file_read / directory_list to understand the user's project
   - Use the Researcher for knowledge synthesis
   Do NOT start implementing until you have enough context to do it correctly.
   A quick context-gathering step upfront prevents failed attempts and wasted effort.`
  }

  // ─── Triage ──────────────────────────────────────────────

  /**
   * Smart triage — classify the prompt into a lane before doing work.
   * This is a single, cheap LLM call that prevents over-engineering simple prompts.
   */
  private async triage(
    prompt: string,
    context: AgentContext,
    relevantMemories: string[] = [],
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
  ): Promise<TriageResult> {
    try {
      // Build memory context string
      const memoryBlock = relevantMemories.length > 0
        ? `\n\nRELEVANT MEMORIES (things you remember about the user and past interactions):\n${relevantMemories.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
        : '\n\nRELEVANT MEMORIES: None found.'

      // Build conversation history string
      const historyBlock = conversationHistory.length > 0
        ? `\n\nCONVERSATION HISTORY (this session so far):\n${conversationHistory.map((msg) => `${msg.role === 'user' ? 'User' : 'Brainwave'}: ${msg.content.slice(0, 300)}`).join('\n')}`
        : ''

      const mcpSummary = this.getMcpSummary()
      const { parsed } = await this.thinkJSON<TriageResult>(
        `You are a strict classifier. Analyze the user prompt and route it to exactly ONE processing lane.
Do NOT answer the question — only classify it.

PROMPT: "${prompt}"${memoryBlock}${historyBlock}

SYSTEM CAPABILITIES — AVAILABLE TOOLS:${mcpSummary}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLASSIFICATION RULES (apply in order — first match wins):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — CHECK IF IT NEEDS TOOLS (→ "direct" with executor or "complex")
Does this prompt require ANY of the following?
  • Web search, live/current data, news, prices, weather, latest versions
  • File system access: read, write, create, delete, move, list files/directories
  • Shell commands: git, npm, python, terminal commands, running scripts
  • HTTP requests, API calls, downloading resources
  • Checking system state, running processes, environment info
If YES to ANY → set the matching toolingNeeds flags to true.
If ANY toolingNeeds flag is true → this CANNOT be "conversational". Route to "direct" agent "executor" (or "complex" if multi-step).

STEP 1.5 — CHECK IF IT'S A SELF-KNOWLEDGE QUESTION (→ "conversational" with factual reply)
Is the user asking about YOUR capabilities, tools, MCP servers, or system configuration?
Examples: "what tools do you have?", "list your MCP servers", "what can Puppeteer do?",
"what tools are in the GitHub server?", "what are your capabilities?"
If YES → the answer is in the SYSTEM CAPABILITIES section above. Use lane "conversational" and
answer ONLY from the data listed above. Do NOT use training knowledge — ONLY report what is
actually listed in the SYSTEM CAPABILITIES section. Include specific tool names from the listing.
NEVER route these to "researcher" — the researcher has NO access to this system data!

STEP 2 — CHECK IF IT'S A KNOWLEDGE/REASONING TASK (→ "direct" with specialist)
Does this prompt ask for:
  • Code generation, debugging, explanation → "direct" agent "coder"
  • Deep analysis of a concept, data, or strategy → "direct" agent "analyst"
  • Creative writing, documentation, blog posts → "direct" agent "writer"
  • Research synthesis from training knowledge → "direct" agent "researcher"
  • Code review or quality check → "direct" agent "reviewer"
  • Critical evaluation, pros/cons assessment → "direct" agent "critic"
If YES → route to the matching specialist agent.

STEP 3 — CHECK IF IT'S MULTI-STEP (→ "complex")
Does this prompt require:
  • Multiple agents working in sequence or parallel
  • Planning before execution (e.g. "research X then build Y")
  • A deliverable that needs research + code + writing
If YES → route to "complex".

STEP 4 — ONLY THEN consider "conversational"
"conversational" is exclusively for prompts that are ALL of these:
  ✓ Pure social interaction (greetings, thanks, farewells, small talk)
  ✓ Require ZERO tools, ZERO specialist knowledge, ZERO factual claims
  ✓ Can be answered with a brief, friendly reply and nothing else

EXAMPLES of CONVERSATIONAL (lane = "conversational"):
  "hello" | "hi there" | "good morning" | "what's your name?" | "thanks!" |
  "how are you?" | "goodbye" | "you're awesome" | "lol" | "do you remember me?" |
  "what tools do you have?" (self-knowledge — answer from SYSTEM CAPABILITIES above) |
  "what MCP servers are connected?" (self-knowledge — answer from SYSTEM CAPABILITIES above) |
  "what can you do?" (self-knowledge — answer from SYSTEM CAPABILITIES above) |
  "what tools does the Puppeteer server have?" (self-knowledge — answer from SYSTEM CAPABILITIES above)

EXAMPLES that are NOT CONVERSATIONAL (common misclassifications to avoid):
  "explain how React hooks work" → direct/researcher (knowledge task)
  "what's the weather?" → direct/executor (needs web search)
  "summarize this for me" → direct/researcher (reasoning task)
  "help me with my project" → direct/executor or complex (needs context)
  "check my files" → direct/executor (file system access)
  "what's new in TypeScript 5?" → direct/executor (needs web search for current info)
  "who is Elon Musk?" → direct/researcher (factual question)
  "remind me tomorrow" → direct/executor (reminder/scheduling)
  "what time is it?" → direct/executor (needs system/live data)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AGENT CAPABILITIES (for "direct" lane routing):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- executor: THE ONLY AGENT WITH TOOLS. Web search, file I/O, shell commands, HTTP requests.
  Route here for ANY task needing real-world interaction.
- researcher: Deep reasoning from training knowledge ONLY. No tools, no internet.
- coder: Code generation, modification, debugging, explanation (in chat only — use executor for disk writes).
- writer: Creative writing, documentation, content generation.
- analyst: Data analysis, pattern recognition, strategic reasoning.
- critic: Critical evaluation, argument analysis, quality assessment.
- reviewer: Code review, accuracy verification, quality checking.

ROUTING PRIORITY:
  1. If it needs tools → executor (or complex if multi-step)
  2. If it needs specialist knowledge → matching agent
  3. If it's multi-step → complex
  4. If and ONLY if it's pure social chit-chat → conversational

CRITICAL: You DO have filesystem, shell, and network access via executor.
NEVER claim you can't do something — route to executor instead.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONVERSATIONAL REPLY RULES (only when lane = "conversational"):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You MUST provide "reply" with a natural, human-like response.
- You are Brainwave, a personal AI assistant with a warm personality
- NEVER say "As an AI..." or anything robotic
- If the user asks if you remember them: CHECK MEMORIES ABOVE. If found, reference them warmly.
  If not found, say "I don't seem to remember — could you remind me?"
- Use CONVERSATION HISTORY to maintain context naturally
- Be warm, concise, and genuine — like a smart friend

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT-FIRST RULE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before choosing a lane, check if you have enough context:
- Review RELEVANT MEMORIES for user preferences, project info, past decisions
- If the task needs current/live information → "direct" → executor (with webSearch: true) or "complex"
- If the task references files/projects → route to executor to gather context first
- NEVER guess when you can look it up

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXTRACTION RULES (apply to ALL lanes):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MEMORY DECISION ("shouldRemember"):
Set true ONLY if the user shares something meaningful:
- Personal info (name, preferences, background), important facts/decisions, useful future context
Set false for: greetings, small talk, thanks, trivial questions, generic requests.

PERSON EXTRACTION ("personInfo"):
If the user mentions a person by name or shares info about themselves:
- When user says "I"/"me"/"my" and you know them from memory → use their known name
- Extract only explicitly stated fields:
  name (REQUIRED), nickname, fullName, relationship, email, phone, address, birthday,
  age, gender, occupation, company, socialLinks, notes, traits, preferences
- Do NOT guess or infer unstated fields

FACT EXTRACTION ("semanticFacts"):
If the user states facts, preferences, or knowledge worth remembering:
- Extract as subject-predicate-object triples
- Only from explicit statements, NOT from questions or greetings

REMINDER EXTRACTION ("reminder"):
If the user expresses a future intention or asks for a reminder:
- Extract: intention, triggerType (time|event|condition), triggerValue, priority (0-1)

TOOLING NEEDS ("toolingNeeds"):
- webSearch: true if ANY live/current data needed (news, prices, weather, versions, lookups, fact-checking)
- fileSystem: true if ANY file/directory read/write/create/delete/move/list needed
- shellCommand: true if ANY terminal/shell command execution needed
- httpRequest: true if ANY external API call or resource download needed
Set ALL false only for tasks answerable purely from knowledge, reasoning, or conversation.
When in doubt → set webSearch: true (better to verify than to guess).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT (strict JSON):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "lane": "conversational" | "direct" | "complex",
  "reply": "your response (REQUIRED for conversational, omit otherwise)",
  "agent": "researcher|coder|writer|analyst|critic|reviewer|executor (REQUIRED for direct, omit otherwise)",
  "toolingNeeds": { "webSearch": false, "fileSystem": false, "shellCommand": false, "httpRequest": false },
  "shouldRemember": true/false,
  "personInfo": { ... } (only if person mentioned),
  "semanticFacts": [{ "subject": "...", "predicate": "...", "object": "..." }] (only if facts shared),
  "reminder": { "intention": "...", "triggerType": "...", "triggerValue": "...", "priority": 0.5 } (only if expressed),
  "reasoning": "one-line explanation of classification decision"
}

FINAL CHECK — before outputting, verify:
• If ANY toolingNeeds flag is true → lane MUST NOT be "conversational"
• If lane is "conversational" → the prompt must be PURE social interaction with zero factual claims
• If lane is "direct" → "agent" field must be set
• When uncertain between conversational and direct → choose "direct" (it's safer to use an agent than to guess)`,
        context,
        { temperature: 0.2 }
      )

      console.log(`[Orchestrator] Triage → ${parsed.lane}: ${parsed.reasoning}`)
      if (parsed.agent) console.log(`[Orchestrator] Triage agent: ${parsed.agent}`)
      if (parsed.toolingNeeds) console.log(`[Orchestrator] Triage toolingNeeds:`, JSON.stringify(parsed.toolingNeeds))
      if (parsed.shouldRemember) console.log(`[Orchestrator] Triage shouldRemember=true`)
      if (parsed.personInfo) console.log(`[Orchestrator] Triage personInfo:`, JSON.stringify(parsed.personInfo))
      if (parsed.reminder) console.log(`[Orchestrator] Triage reminder:`, JSON.stringify(parsed.reminder))
      return parsed
    } catch (err) {
      // If triage itself fails, fall back to full pipeline
      console.error('[Orchestrator] Triage failed, falling back to complex:', err)
      return { lane: 'complex', reasoning: 'triage failed, using full pipeline' }
    }
  }

  /** Register the function used to execute individual agent tasks */
  setExecutor(executor: AgentExecutorFn): void {
    this.agentExecutor = executor
  }

  /** Main entry point — submit a user task */
  async submitTask(prompt: string, priority: 'low' | 'normal' | 'high' = 'normal', sessionId?: string, images?: ImageAttachment[]): Promise<TaskRecord> {
    const taskId = randomUUID()
    const task: TaskRecord = {
      id: taskId,
      prompt,
      priority,
      status: 'pending',
      createdAt: Date.now(),
      images,
    }

    this.activeTasks.set(taskId, task)

    // Persist to DB
    this.db.run(
      `INSERT INTO tasks (id, title, description, status, priority, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      taskId,
      prompt.slice(0, 200),
      prompt,
      'pending',
      priority === 'high' ? 0.9 : priority === 'normal' ? 0.5 : 0.2,
      sessionId ?? null
    )

    // Update session timestamp
    if (sessionId) {
      this.db.run(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`, Date.now(), sessionId)
    }

    this.bus.emitEvent('task:submitted', { taskId, prompt, priority })

    // Run asynchronously — don't block the caller
    this.processTask(task, sessionId).catch((err) => {
      console.error(`[Orchestrator] Task ${taskId} failed:`, err)
      this.failTask(task, err instanceof Error ? err.message : String(err))
    })

    return task
  }

  /** Cancel a running task */
  cancelTask(taskId: string): boolean {
    const task = this.activeTasks.get(taskId)
    if (!task || task.status === 'completed' || task.status === 'failed') return false

    task.status = 'cancelled'
    this.db.run(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`, taskId)
    this.bus.emitEvent('task:cancelled', { taskId })

    return true
  }

  /** Get all active tasks */
  getActiveTasks(): TaskRecord[] {
    return [...this.activeTasks.values()]
  }

  /** Get recent task history from DB (persisted across restarts) */
  getTaskHistory(limit = 50, sessionId?: string): TaskRecord[] {
    const whereClause = sessionId ? `WHERE session_id = ?` : ''
    const params = sessionId ? [sessionId, limit] : [limit]
    const rows = this.db.all(
      `SELECT id, title, description, status, priority, result, error, created_at, completed_at
       FROM tasks ${whereClause} ORDER BY created_at DESC LIMIT ?`,
      ...params
    ) as Array<{
      id: string
      title: string
      description: string
      status: string
      priority: number
      result: string | null
      error: string | null
      created_at: string
      completed_at: string | null
    }>

    return rows.map((row) => ({
      id: row.id,
      prompt: row.description || row.title,
      priority: row.priority >= 0.8 ? 'high' as const : row.priority >= 0.4 ? 'normal' as const : 'low' as const,
      status: this.mapDbStatus(row.status),
      result: row.result ? this.safeParseJSON(row.result) : undefined,
      error: row.error ?? undefined,
      createdAt: new Date(row.created_at).getTime(),
      completedAt: row.completed_at ? new Date(row.completed_at).getTime() : undefined,
    }))
  }

  private mapDbStatus(dbStatus: string): TaskRecord['status'] {
    const map: Record<string, TaskRecord['status']> = {
      pending: 'pending',
      planning: 'planning',
      in_progress: 'in_progress',
      delegated: 'in_progress',
      blocked: 'pending',
      completed: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
    }
    return map[dbStatus] ?? 'pending'
  }

  private safeParseJSON(str: string): unknown {
    try {
      return JSON.parse(str)
    } catch {
      return str
    }
  }

  /** Get a specific task */
  getTask(taskId: string): TaskRecord | undefined {
    return this.activeTasks.get(taskId)
  }

  // ─── Core Processing Pipeline ────────────────────────────

  private async processTask(task: TaskRecord, sessionId?: string): Promise<void> {
    try {
      // 0. Memory recall — gather relevant context from past experiences
      const memoryManager = getMemoryManager()
      const workingMemory = getWorkingMemory()

      workingMemory.setTask(task.id, task.prompt)

      let relevantMemories: string[] = []
      try {
        relevantMemories = await memoryManager.recallForContext(task.prompt, 8)
        if (relevantMemories.length > 0) {
          workingMemory.set('recalled_memories', JSON.stringify(relevantMemories))
          this.bus.emitEvent('system:log', {
            level: 'info',
            message: `Recalled ${relevantMemories.length} relevant memories for task`,
            data: { taskId: task.id },
          })
        }
      } catch (err) {
        console.warn('[Orchestrator] Memory recall failed, continuing without:', err)
      }

      // 0b. Fetch session conversation history for context continuity
      let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
      if (sessionId) {
        try {
          const rows = this.db.all(
            `SELECT description, result, status FROM tasks
             WHERE session_id = ? AND id != ? AND status IN ('completed', 'failed')
             ORDER BY created_at ASC LIMIT 20`,
            sessionId, task.id
          ) as Array<{ description: string; result: string | null; status: string }>

          for (const row of rows) {
            conversationHistory.push({ role: 'user', content: row.description })
            if (row.result) {
              try {
                const parsed = JSON.parse(row.result)
                conversationHistory.push({ role: 'assistant', content: typeof parsed === 'string' ? parsed : JSON.stringify(parsed) })
              } catch {
                conversationHistory.push({ role: 'assistant', content: row.result })
              }
            }
          }
          if (conversationHistory.length > 0) {
            console.log(`[Orchestrator] Loaded ${conversationHistory.length / 2} prior exchanges from session`)
          }
        } catch (err) {
          console.warn('[Orchestrator] Failed to load session history:', err)
        }
      }

      // 1. Triage — classify the prompt before doing heavy work
      task.status = 'planning'
      this.db.run(`UPDATE tasks SET status = 'planning' WHERE id = ?`, task.id)
      this.bus.emitEvent('task:planning', { taskId: task.id })

      const triageContext: AgentContext = { taskId: task.id, relevantMemories, conversationHistory, images: task.images }
      const triage = await this.triage(task.prompt, triageContext, relevantMemories, conversationHistory)

      // 1b. Apply code-level routing guards (prompts are suggestions; guards are law)
      this.applyTriageGuards(triage, task.prompt)

      // 2. Route based on triage lane
      console.log(`[Orchestrator] Routing task ${task.id} to lane: ${triage.lane}${triage.agent ? ` (agent: ${triage.agent})` : ''}`)
      switch (triage.lane) {
        case 'conversational':
          await this.handleConversational(task, triage, memoryManager, relevantMemories, conversationHistory)
          break
        case 'direct':
          await this.handleDirect(task, triage, relevantMemories, memoryManager, conversationHistory)
          break
        case 'complex':
          await this.handleComplex(task, relevantMemories, memoryManager, conversationHistory)
          break
      }

      // 3. Save triage extractions (person, facts, reminders, episodic) — runs for ALL lanes
      await this.saveTriageExtractions(task, triage, memoryManager)

      // 4. Clear working memory
      workingMemory.clear()
    } catch (err) {
      this.failTask(task, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  // ─── Lane Handlers ────────────────────────────────────────

  /**
   * Conversational lane — instant reply, no agents.
   * Cheapest path: triage already generated the reply.
   */
  private async handleConversational(
    task: TaskRecord,
    triage: TriageResult,
    memoryManager: ReturnType<typeof getMemoryManager>,
    relevantMemories: string[] = [],
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
  ): Promise<void> {
    // If triage reply mentions memory/remembering and we have memories, do a richer LLM call
    let reply = triage.reply ?? 'Hello! How can I help you?'
    const needsMemoryAwareness = /remember|know me|who am i|my name|forget/i.test(task.prompt)

    if (needsMemoryAwareness || conversationHistory.length > 0) {
      try {
        const adapter = LLMFactory.getForAgent('orchestrator')

        // Fetch known people for identity-related questions
        let peopleContext = ''
        if (needsMemoryAwareness) {
          try {
            const peopleStore = getPeopleStore()
            const allPeople = peopleStore.getAll(10)
            if (allPeople.length > 0) {
              peopleContext = '\n\nPeople you know:\n' + allPeople.map((p) => {
                const parts = [`- ${p.name}`]
                if (p.nickname && p.nickname !== p.name) parts.push(`aka "${p.nickname}"`)
                if (p.fullName && p.fullName !== p.name) parts.push(`(full name: ${p.fullName})`)
                if (p.relationship) parts.push(`[${p.relationship}]`)
                if (p.occupation) parts.push(`— ${p.occupation}${p.company ? ` @ ${p.company}` : ''}`)
                if (p.age) parts.push(`— age: ${p.age}`)
                if (p.email) parts.push(`— email: ${p.email}`)
                if (p.address) parts.push(`— location: ${p.address}`)
                if (p.traits.length > 0) parts.push(`— traits: ${p.traits.join(', ')}`)
                if (Object.keys(p.preferences).length > 0) parts.push(`— preferences: ${JSON.stringify(p.preferences)}`)
                return parts.join(' ')
              }).join('\n')
            }
          } catch (err) {
            console.warn('[Orchestrator] Failed to fetch people for context:', err)
          }
        }

        const memoryContext = relevantMemories.length > 0
          ? `Things you remember:\n${relevantMemories.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
          : 'You have no relevant memories about this topic.'
        const historyContext = conversationHistory.length > 0
          ? `\n\nConversation so far:\n${conversationHistory.map((msg) => `${msg.role === 'user' ? 'User' : 'You'}: ${msg.content.slice(0, 300)}`).join('\n')}`
          : ''

        const response = await adapter.complete({
          system: `You are Brainwave — a personal AI assistant with a warm, genuine, human personality.

CRITICAL RULES:
- NEVER say "As an AI" or "I don't remember in the way humans do" or anything robotic
- NEVER say "I can't access files" or "I don't have the ability to" — you DO have full computer access via your tools
- You have a memory system. Use the memories provided below to answer naturally.
- If the "People you know" section lists someone with relationship "owner" or "owner/creator", THAT IS THE USER — use their name confidently
- If memories contain info about the user, reference it warmly: "Of course! I remember..."
- If someone asks "who am I" or "do you know my name" and you have a person with relationship owner/creator, say their name immediately
- If no relevant memories exist, say "Hmm, I don't seem to remember that — could you tell me?"
- Ask clarifying questions when you're unsure, instead of making assumptions
- Be warm, concise, and genuine — like a thoughtful friend
- Reference the conversation history naturally to maintain context
- Keep responses focused and helpful
- NEVER output tool calls, XML tags, JSON blocks, or code markers like <tool_call>, [TOOL_CALL], {"tool":...} etc. Just reply in plain natural language.
- When asked about your capabilities, tools, or MCP servers, ONLY report what is listed in SYSTEM CAPABILITIES below. Do NOT guess or hallucinate additional servers/tools.
${task.images?.length ? '- The user has attached image(s). Describe and reference them naturally in your response.' : ''}

${memoryContext}${peopleContext}${historyContext}

SYSTEM CAPABILITIES — AVAILABLE TOOLS:${this.getMcpSummary()}`,
          user: task.prompt,
          temperature: 0.7,
          maxTokens: 1024,
          images: task.images?.map((img) => ({ data: img.data, mimeType: img.mimeType })),
        })
        reply = response.content
      } catch (err) {
        console.warn('[Orchestrator] Memory-aware conversational reply failed, using triage reply:', err)
      }
    }

    // Strip any tool call artifacts the LLM may have emitted
    reply = this.sanitizeConversationalReply(reply)

    task.status = 'completed'
    task.result = reply
    task.completedAt = Date.now()

    this.db.run(
      `UPDATE tasks SET status = 'completed', result = ?, assigned_agent = 'orchestrator', completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      JSON.stringify(reply),
      task.id
    )

    this.bus.emitEvent('task:completed', { taskId: task.id, result: reply })
  }

  /**
   * Strip tool call artifacts that the LLM may emit in conversational replies.
   * The conversational lane doesn't execute tools — triage handles memory/facts separately.
   */
  private sanitizeConversationalReply(text: string): string {
    let cleaned = text
    // Remove <tool_call>...</tool_call> and <tool-call>...</tool-call> blocks (with any whitespace)
    cleaned = cleaned.replace(/<\/?tool[-_]?call>\s*/gi, '')
    // Remove [TOOL_CALL]...JSON...[/TOOL_CALL] or standalone [TOOL_CALL]
    cleaned = cleaned.replace(/\[\/?\s*TOOL[-_]?CALL\s*\]\s*/gi, '')
    // Remove standalone JSON tool objects: { "tool": "...", ... }
    cleaned = cleaned.replace(/\{\s*"tool"\s*:\s*"[^"]*"[\s\S]*?\}\s*/g, '')
    // Collapse multiple newlines left by removals
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n')
    return cleaned.trim()
  }

  /**
   * Save all triage extractions — person info, semantic facts, reminders, episodic memory.
   * Called after ALL lanes (conversational, direct, complex) so nothing is lost.
   */
  private async saveTriageExtractions(
    task: TaskRecord,
    triage: TriageResult,
    memoryManager: ReturnType<typeof getMemoryManager>
  ): Promise<void> {
    // Auto-create/update person if triage extracted person info
    if (triage.personInfo?.name) {
      try {
        const peopleStore = getPeopleStore()
        const pi = triage.personInfo

        const person = peopleStore.store({
          name: pi.name,
          nickname: pi.nickname,
          fullName: pi.fullName,
          relationship: pi.relationship,
          email: pi.email,
          phone: pi.phone,
          address: pi.address,
          birthday: pi.birthday,
          age: pi.age,
          gender: pi.gender,
          occupation: pi.occupation,
          company: pi.company,
          socialLinks: pi.socialLinks,
          notes: pi.notes,
          traits: pi.traits,
          preferences: pi.preferences,
        })
        console.log(`[Orchestrator] Created/updated person: ${person.name} (${person.id})`)
      } catch (err) {
        console.warn('[Orchestrator] Failed to store person:', err)
      }
    }

    // Store semantic facts/preferences if triage extracted any
    if (triage.semanticFacts?.length) {
      for (const fact of triage.semanticFacts) {
        try {
          await memoryManager.storeSemantic({
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
            confidence: 0.8,
            source: 'conversation',
            tags: ['user-stated'],
          })
          console.log(`[Orchestrator] Stored semantic fact: ${fact.subject} ${fact.predicate} ${fact.object}`)
        } catch (err) {
          console.warn('[Orchestrator] Failed to store semantic fact:', err)
        }
      }
    }

    // Create prospective memory if triage detected a reminder/intention
    if (triage.reminder) {
      try {
        const prospectiveStore = getProspectiveStore()
        const entry = prospectiveStore.store({
          intention: triage.reminder.intention,
          triggerType: triage.reminder.triggerType,
          triggerValue: triage.reminder.triggerValue,
          priority: triage.reminder.priority ?? 0.5,
          tags: ['user-requested'],
        })
        console.log(`[Orchestrator] Created prospective memory: ${entry.intention} (${entry.id})`)
      } catch (err) {
        console.warn('[Orchestrator] Failed to store prospective memory:', err)
      }
    }

    // Store episodic memory if triage decided this interaction is worth remembering
    if (triage.shouldRemember) {
      try {
        await memoryManager.storeEpisodic({
          content: `User said: "${task.prompt.slice(0, 200)}". Lane: ${triage.lane}.`,
          source: 'orchestrator',
          importance: 0.4,
          emotionalValence: 0.5,
          tags: [triage.lane, 'remembered'],
          participants: ['orchestrator'],
        })
        console.log('[Orchestrator] Stored memory — triage deemed worth remembering')
      } catch {
        // Not critical
      }
    }
  }

  /**
   * Direct lane — skip planner, route to a single agent.
   * Medium cost: one triage call + one agent call, no planning or reflection overhead.
   */
  private async handleDirect(
    task: TaskRecord,
    triage: TriageResult,
    relevantMemories: string[],
    memoryManager: ReturnType<typeof getMemoryManager>,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
  ): Promise<void> {
    const agentType = triage.agent ?? ('coder' as AgentType)
    console.log(`[Orchestrator] handleDirect() → agent=${agentType} | task="${task.prompt.slice(0, 100)}"`)

    // Build a single-step plan inline (no planner LLM call)
    const plan: TaskPlan = {
      id: `plan_${randomUUID().slice(0, 8)}`,
      taskId: task.id,
      originalTask: task.prompt,
      subTasks: [{
        id: 'direct-task',
        description: this.augmentTaskForAgent(task.prompt, agentType, triage.toolingNeeds),
        assignedAgent: agentType,
        status: 'pending',
        dependencies: [],
        attempts: 0,
        maxAttempts: 2,
      }],
      estimatedComplexity: 'simple',
      requiredAgents: [agentType],
    }

    task.plan = plan
    this.db.run(
      `UPDATE tasks SET plan = ?, assigned_agent = ? WHERE id = ?`,
      JSON.stringify(plan),
      agentType,
      task.id
    )

    this.bus.emitEvent('plan:created', {
      taskId: task.id,
      planId: plan.id,
      steps: 1,
      agents: [agentType],
    })

    // Execute
    task.status = 'in_progress'
    this.db.run(`UPDATE tasks SET status = 'in_progress', started_at = CURRENT_TIMESTAMP WHERE id = ?`, task.id)

    const results = await this.executePlan(task, plan, relevantMemories, conversationHistory)
    if (task.status === 'cancelled') return

    // Check if all subtasks failed — provide a clear error instead of null
    const allFailed = plan.subTasks.every((st) => st.status === 'failed')
    if (allFailed) {
      const errors = plan.subTasks
        .map((st) => st.error || results.get(st.id)?.error)
        .filter(Boolean)
      const errorSummary = errors.length > 0
        ? `I wasn't able to complete this task. Here's what went wrong:\n\n${errors.map((e) => `- ${e}`).join('\n')}`
        : 'I wasn\'t able to complete this task — all attempts failed. Please try again or rephrase your request.'
      await this.completeTask(task, errorSummary, plan, memoryManager)
      return
    }

    // For single-step plans, use raw output ONLY if it's already a clean string.
    // Structured JSON from agents (researcher, analyst, etc.) must be synthesized
    // into a human-readable response — never show raw JSON to the user.
    let finalResult: unknown
    if (plan.subTasks.length === 1) {
      const rawOutput = results.get(plan.subTasks[0].id)?.output ?? null
      if (typeof rawOutput === 'string' && rawOutput.trim()) {
        finalResult = rawOutput
      } else {
        // Structured output (e.g. ResearchOutput, AnalystOutput) → synthesize
        finalResult = await this.synthesizeAnswer(plan, results)
      }
    } else {
      finalResult = await this.synthesizeAnswer(plan, results)
    }
    await this.completeTask(task, finalResult, plan, memoryManager)
  }

  /**
   * Complex lane — full pipeline: planner → DAG → reflection.
   * Most expensive path, used only when genuinely needed.
   */
  private async handleComplex(
    task: TaskRecord,
    relevantMemories: string[],
    memoryManager: ReturnType<typeof getMemoryManager>,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
  ): Promise<void> {
    console.log(`[Orchestrator] handleComplex() | task="${task.prompt.slice(0, 100)}"`)

    // Planning phase (LLM call to decompose)
    this.bus.emitEvent('task:progress', {
      taskId: task.id, progress: 0,
      currentStep: 'Planner is breaking down the task...',
    })

    const plan = await this.planner.decompose(task.id, task.prompt)

    // Apply code-level plan guards — fix misrouted subtasks before execution
    this.applyPlanGuards(plan)

    task.plan = plan

    this.db.run(
      `UPDATE tasks SET plan = ?, assigned_agent = 'orchestrator' WHERE id = ?`,
      JSON.stringify(plan),
      task.id
    )

    // Notify renderer of the plan with step details
    this.bus.emitEvent('plan:created', {
      taskId: task.id,
      planId: plan.id,
      steps: plan.subTasks.length,
      agents: plan.requiredAgents,
    })

    // Execution phase — run the DAG
    task.status = 'in_progress'
    this.db.run(`UPDATE tasks SET status = 'in_progress', started_at = CURRENT_TIMESTAMP WHERE id = ?`, task.id)

    const results = await this.executePlan(task, plan, relevantMemories, conversationHistory)
    if (task.status === 'cancelled') return

    // Synthesize a human-readable answer from all agent outputs
    this.bus.emitEvent('task:progress', {
      taskId: task.id, progress: 95,
      currentStep: 'Synthesizing final answer...',
    })
    const finalResult = await this.synthesizeAnswer(plan, results)
    await this.completeTask(task, finalResult, plan, memoryManager)

    // Auto-reflect (async, non-blocking)
    this.triggerReflection(task, plan, results).catch((err) => {
      console.warn('[Orchestrator] Reflection failed:', err)
    })
  }

  /** Shared completion logic for direct and complex lanes */
  private async completeTask(
    task: TaskRecord,
    result: unknown,
    plan: TaskPlan,
    memoryManager: ReturnType<typeof getMemoryManager>
  ): Promise<void> {
    task.status = 'completed'
    task.result = result
    task.completedAt = Date.now()

    this.db.run(
      `UPDATE tasks SET status = 'completed', result = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      JSON.stringify(result),
      task.id
    )

    this.bus.emitEvent('task:completed', { taskId: task.id, result })

    // Store experience as episodic memory
    try {
      await memoryManager.storeEpisodic({
        content: `Task completed: "${task.prompt.slice(0, 200)}". Result: ${JSON.stringify(result).slice(0, 500)}`,
        source: 'orchestrator',
        importance: task.priority === 'high' ? 0.8 : task.priority === 'normal' ? 0.5 : 0.3,
        emotionalValence: 0.6,
        tags: ['task-completed', `priority-${task.priority}`],
        participants: ['orchestrator', ...plan.requiredAgents],
      })
    } catch (err) {
      console.warn('[Orchestrator] Failed to store task memory:', err)
    }
  }

  /**
   * Trigger post-task reflection (fire-and-forget).
   * Builds a reflective context from the task, plan, and all results,
   * then lets the ReflectionAgent extract lessons and propose rules.
   */
  private async triggerReflection(
    task: TaskRecord,
    plan: TaskPlan,
    results: Map<string, AgentResult>
  ): Promise<void> {
    const subTask: SubTask = {
      id: `reflection-${task.id}`,
      description: `Reflect on completed task: ${task.prompt}`,
      assignedAgent: 'reflection' as AgentType,
      dependencies: [],
      priority: 'low',
      status: 'pending',
    }

    // Build sibling results so reflection can see all agent outputs
    const siblingResults = new Map<string, AgentResult>()
    for (const [id, result] of results) {
      siblingResults.set(id, result)
    }

    const context: AgentContext = {
      taskId: task.id,
      parentTaskId: task.id,
      conversationHistory: [],
      relevantMemories: [],
      siblingResults,
      metadata: {
        originalPrompt: task.prompt,
        plan: JSON.stringify(plan),
        priority: task.priority,
      },
    }

    const reflectionResult = await this.reflector.execute(subTask, context)

    this.bus.emitEvent('agent:completed', {
      taskId: task.id,
      agentType: 'reflection',
      result: reflectionResult,
    })
  }

  /**
   * Execute a task plan, respecting the dependency DAG.
   * Independent sub-tasks run in parallel.
   */
  private async executePlan(
    task: TaskRecord,
    plan: TaskPlan,
    relevantMemories: string[] = [],
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
  ): Promise<Map<string, AgentResult>> {
    const results = new Map<string, AgentResult>()
    const remaining = new Set(plan.subTasks.map((st) => st.id))
    const completed = new Set<string>()

    while (remaining.size > 0) {
      // Check for cancellation
      if (task.status === 'cancelled') break

      // Find all tasks whose dependencies are satisfied
      const ready = plan.subTasks.filter(
        (st) =>
          remaining.has(st.id) &&
          st.dependencies.every((dep) => completed.has(dep))
      )

      if (ready.length === 0 && remaining.size > 0) {
        throw new Error(
          `Deadlock: ${remaining.size} tasks remaining but none are ready. ` +
          `Possibly circular dependencies.`
        )
      }

      // Execute ready tasks in parallel
      const executions = ready.map(async (subTask) => {
        subTask.status = 'in-progress'
        console.log(`[Orchestrator] executePlan: dispatching ${subTask.assignedAgent} for subtask "${subTask.id}" — "${subTask.description.slice(0, 100)}"`)

        const stepIndex = plan.subTasks.indexOf(subTask) + 1
        this.bus.emitEvent('task:progress', {
          taskId: task.id,
          progress: Math.round(
            ((completed.size) / plan.subTasks.length) * 100
          ),
          currentStep: `[${stepIndex}/${plan.subTasks.length}] ${subTask.assignedAgent} → ${subTask.description}`,
        })

        const result = await this.executeSubTask(subTask, {
          taskId: task.id,
          planId: plan.id,
          parentTask: plan.originalTask,
          relevantMemories,
          conversationHistory,
          siblingResults: results,
          images: task.images,
        })

        results.set(subTask.id, result)

        // Check escalation rules (confidence threshold, destructive action, etc.)
        if (result.status === 'success' || result.status === 'partial') {
          const escalation = getSoftEngine().checkEscalation({
            confidence: result.confidence,
            taskDescription: subTask.description,
          })
          if (escalation?.shouldEscalate) {
            // Emit a warning — the UI can display this to the user
            this.bus.emitEvent('task:escalation', {
              taskId: task.id,
              stepId: subTask.id,
              agent: subTask.assignedAgent,
              error: escalation.message,
              attempts: 0,
              message: `⚠ Low confidence (${(result.confidence * 100).toFixed(0)}%): ${escalation.message}`,
            })
          }
        }

        if (result.status === 'success' || result.status === 'partial') {
          subTask.status = 'completed'
          subTask.result = result.output
          completed.add(subTask.id)
          remaining.delete(subTask.id)

          this.bus.emitEvent('plan:step-completed', {
            taskId: task.id,
            planId: plan.id,
            stepId: subTask.id,
            agentType: subTask.assignedAgent,
          })
        } else {
          // Retry logic with error context for self-correction
          subTask.attempts++
          if (subTask.attempts < subTask.maxAttempts) {
            subTask.status = 'retrying'
            // Attach error to description so agent can self-correct on retry
            if (result.error && !subTask.description.includes('PREVIOUS ATTEMPT FAILED')) {
              subTask.description += `\n\nPREVIOUS ATTEMPT FAILED: ${result.error}\nPlease fix the issue and try a different approach.`
            }
            console.log(
              `[Orchestrator] Retrying ${subTask.id} (attempt ${subTask.attempts + 1}/${subTask.maxAttempts}): ${result.error?.slice(0, 100)}`
            )
            // Will be picked up in the next loop iteration
          } else {
            subTask.status = 'failed'
            subTask.error = result.error
            remaining.delete(subTask.id)
            completed.add(subTask.id)

            this.bus.emitEvent('plan:step-failed', {
              taskId: task.id,
              planId: plan.id,
              stepId: subTask.id,
              error: result.error ?? 'Unknown error',
            })

            // Escalation: notify user that retries are exhausted
            this.bus.emitEvent('task:escalation', {
              taskId: task.id,
              stepId: subTask.id,
              agent: subTask.assignedAgent,
              error: result.error ?? 'Unknown error',
              attempts: subTask.attempts,
              message: `Agent "${subTask.assignedAgent}" failed after ${subTask.attempts} attempts on: "${subTask.description.slice(0, 100)}"`,
            })
          }
        }
      })

      await Promise.all(executions)
    }

    // Final progress update
    this.bus.emitEvent('task:progress', {
      taskId: task.id,
      progress: 100,
      currentStep: 'Complete',
    })

    return results
  }

  /**
   * Execute a single sub-task via the registered executor.
   * If no executor is registered, uses the base agent's think() directly.
   */
  private async executeSubTask(subTask: SubTask, context: AgentContext): Promise<AgentResult> {
    if (this.agentExecutor) {
      return this.agentExecutor(subTask, context)
    }

    // Fallback: execute via orchestrator's own LLM (not ideal, but functional)
    console.warn(`[Orchestrator] No agent executor registered, using self for ${subTask.assignedAgent}`)
    return this.execute(subTask, context)
  }

  /**
   * Synthesize a human-readable answer from all agent outputs.
   * Makes a final LLM call to compile scattered outputs into one coherent response.
   */
  private async synthesizeAnswer(plan: TaskPlan, results: Map<string, AgentResult>): Promise<string> {
    // Build context from all agent outputs
    const agentOutputs = plan.subTasks.map((st) => {
      const result = results.get(st.id)
      const output = result?.output
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2)
      return `### Step: ${st.description} (Agent: ${st.assignedAgent}, Status: ${st.status})\n${outputStr}`
    }).join('\n\n')

    try {
      const adapter = LLMFactory.getForAgent('orchestrator')
      const response = await adapter.complete({
        system: `You are Brainwave — a personal AI assistant with a warm, genuine, human personality.
You are synthesizing results from your internal thinking into one cohesive answer.

Rules:
- Write a clear, well-structured, human-readable response
- Do NOT include raw JSON, confidence scores, or internal metadata
- Do NOT mention agents, steps, or internal processes — the user doesn't know about them
- NEVER say "As an AI" or anything robotic — you are Brainwave, act like a knowledgeable friend
- Answer the user's original question directly and thoroughly
- Use markdown formatting (headers, lists, bold) for readability
- If you couldn't fully answer something, be honest and suggest next steps
- Ask clarifying questions if the answer depends on assumptions`,
        user: `Original question: "${plan.originalTask}"\n\nAgent outputs:\n${agentOutputs}\n\nSynthesize these into a clear, comprehensive answer.`,
        temperature: 0.5,
        maxTokens: 4096,
      })
      return response.content
    } catch (err) {
      console.warn('[Orchestrator] Synthesis failed, falling back to raw compilation:', err)
      // Fallback: concatenate agent outputs as plain text
      const parts = plan.subTasks
        .map((st) => {
          const result = results.get(st.id)
          if (!result?.output) return null
          return typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
        })
        .filter((p): p is string => p !== null && p !== 'null' && p.trim() !== '')

      if (parts.length === 0) {
        // All agents failed and synthesis failed — give a human-readable error
        const errors = plan.subTasks
          .map((st) => st.error || results.get(st.id)?.error)
          .filter(Boolean)
        return errors.length > 0
          ? `I wasn't able to complete this task. Here's what went wrong:\n\n${errors.map((e) => `- ${e}`).join('\n')}`
          : 'I wasn\'t able to complete this task — all attempts failed. Please try again or rephrase your request.'
      }

      return parts.join('\n\n---\n\n')
    }
  }

  // ─── Code-Level Routing Guards ──────────────────────────
  //
  // These guards enforce hard constraints that override LLM decisions.
  // Prompts are suggestions; guards are law.
  //

  /**
   * Fix incorrect triage routing.
   * 1. Conversational guard: catches factual/tool-needing prompts stuck in conversational lane.
   * 2. Direct guard: catches tool-needing prompts assigned to non-executor agents.
   */
  private applyTriageGuards(triage: TriageResult, prompt: string): void {
    // ── Guard 1: Conversational → Direct redirect ──
    // Catches prompts that were classified as conversational but need tools or specialist knowledge
    if (triage.lane === 'conversational') {
      const lower = prompt.toLowerCase()

      // Check if toolingNeeds contradicts conversational lane
      const needs = triage.toolingNeeds
      if (needs && (needs.webSearch || needs.fileSystem || needs.shellCommand || needs.httpRequest)) {
        const flags = Object.entries(needs).filter(([, v]) => v).map(([k]) => k).join(', ')
        console.log(`[Orchestrator] \u{1F6E1} Conv guard: toolingNeeds [${flags}] contradicts conversational — redirecting to direct/executor`)
        triage.lane = 'direct'
        triage.agent = 'executor'
        triage.reasoning += ` [GUARD: toolingNeeds requires executor, not conversational]`
        triage.reply = undefined as unknown as string
        return
      }

      // Regex patterns that should NEVER be conversational
      // EXCEPTION: Self-knowledge questions about MCP/tools/capabilities ARE allowed
      // in conversational since the MCP summary with tool names is injected into the prompt
      const SELF_KNOWLEDGE = [
        /\b(what|which|list|show|tell)\b.*\b(tools?|mcps?|servers?|capabilities?|agents?|features?)\b.*\b(do you|are|have|connected|available|can you)\b/i,
        /\bwhat\s+(can|could)\s+you\s+do\b/i,
        /\blist\s+(your|all|the|my|me)\s+(tools?|mcps?|servers?|capabilities?|agents?)\b/i,
        /\bhow\s+many\s+(tools?|mcps?|servers?|agents?)\b/i,
        /\bwhat\s+are\s+your\s+(capabilities|features|functions)\b/i,
        /\bwhat\s+(tools?|functions?)\s+(are|does)\s+(available|the)\b.*\b(mcp|server)\b/i,
        /\bmcp\s+server\b.*\b(tools?|capabilities?)\b/i,
      ]
      const isSelfKnowledge = SELF_KNOWLEDGE.some(p => p.test(lower))
      if (isSelfKnowledge) {
        // Self-knowledge question — let it stay in conversational (MCP data is in the prompt)
        return
      }

      const NOT_CONVERSATIONAL = [
        // File/shell operations
        /\b(read|write|create|delete|move|open|check|list)\s+(a\s+|the\s+|my\s+)?(file|folder|directory|dir)\b/i,
        /\b(run|execute)\s+(a\s+|the\s+)?(command|script|shell|terminal)\b/i,
        /\b(git|npm|pip|python|node|curl)\s/i,
        // Web search / live data
        /\b(search|google|look\s*up|find)\s+(the\s+|for\s+)?(web|internet|online)?\b.{3,}/i,
        /\b(what('s|\s+is)\s+the\s+(weather|time|date|price|latest|current))\b/i,
        /\b(who\s+(is|was|are)\s+\w+)/i,
        // Knowledge questions (not small talk)
        /\b(explain|describe|how\s+does|what\s+is|define|tell\s+me\s+about)\s+\w+/i,
        // Reminders/scheduling
        /\bremind\s+me\b/i,
      ]

      if (NOT_CONVERSATIONAL.some(p => p.test(lower))) {
        // Determine best agent based on prompt content
        const needsTools = /\b(search|fetch|read|write|create|delete|run|execute|check|list|open|curl|git|npm|pip|file|folder|dir|weather|time|price|latest|current)\b/i.test(lower)
        const agent = needsTools ? 'executor' : 'researcher'
        console.log(`[Orchestrator] \u{1F6E1} Conv guard: prompt matches non-conversational pattern — redirecting to direct/${agent}`)
        triage.lane = 'direct'
        triage.agent = agent
        triage.reasoning += ` [GUARD: prompt is not pure social interaction — redirected to ${agent}]`
        triage.reply = undefined as unknown as string
        return
      }
    }

    // ── Guard 2: Direct-lane tool redirect ──
    if (triage.lane !== 'direct') return

    // ── Primary Defense: Capability-based routing via toolingNeeds ──
    // The triage LLM understands intent perfectly — it flags what the task NEEDS.
    // We just enforce that only executor has tools.
    const needs = triage.toolingNeeds
    if (needs) {
      const needsTools = needs.webSearch || needs.fileSystem || needs.shellCommand || needs.httpRequest
      if (needsTools && triage.agent !== 'executor') {
        const flags = Object.entries(needs).filter(([, v]) => v).map(([k]) => k).join(', ')
        console.log(`[Orchestrator] \u{1F6E1} Tooling guard: task needs [${flags}] — redirecting ${triage.agent} → executor`)
        triage.agent = 'executor'
        triage.reasoning += ` [GUARD: task requires tooling (${flags}) — only executor has tools]`
        return // primary defense handled it, skip fallback
      }
    }

    // ── Fallback: Regex safety net (belt + suspenders) ──
    // Catches cases where the LLM forgot to set toolingNeeds correctly.
    const WEB_FALLBACK = [
      /search\s+(the\s+)?(web|internet|online)/i,
      /\bgoogle\b/i,
      /\bweb\s*search\b/i,
    ]
    const FILE_FALLBACK = [
      /\b(read|write|create|delete|move|rename|copy)\s+(a\s+|the\s+)?(file|directory|folder)\b/i,
      /\b(run|execute)\s+(a\s+|the\s+)?(command|script|shell)\b/i,
      /\b(git|npm|pip|python|node|curl|wget|powershell|bash)\s/i,
    ]

    const needsWebFallback = WEB_FALLBACK.some(p => p.test(prompt))
    const needsFileFallback = FILE_FALLBACK.some(p => p.test(prompt))

    if ((needsWebFallback || needsFileFallback) && triage.agent !== 'executor') {
      const reason = needsWebFallback ? 'web search (regex fallback)' : 'file/shell (regex fallback)'
      console.log(`[Orchestrator] \u{1F6E1} Fallback guard: ${reason} — redirecting ${triage.agent} → executor`)
      triage.agent = 'executor'
      triage.reasoning += ` [GUARD FALLBACK: ${reason}]`
    }
  }

  /**
   * Post-process planner output — fix misrouted subtasks in the DAG.
   * The planner LLM might assign web search tasks to researcher,
   * but researcher has no tools. This catches and fixes it.
   */
  private applyPlanGuards(plan: TaskPlan): void {
    let modified = false

    for (const st of plan.subTasks) {
      const lower = st.description.toLowerCase()

      // Web search / live data subtasks → executor (researcher has no tools)
      const needsWebSearch =
        /\b(search\s+(the\s+)?(web|internet|online)|web.?search|find\s+online|browse|scrape)\b/.test(lower)
      const needsLiveData =
        /\b(latest|newest|current|recent|up-to-date|real-time|live)\b/.test(lower) &&
        /\b(data|info|news|release|model|update|version|price|result)\b/.test(lower)

      if ((needsWebSearch || needsLiveData) && st.assignedAgent === 'researcher') {
        console.log(`[Orchestrator] \u{1F6E1} Plan guard: subtask "${st.id}" needs web access — researcher → executor`)
        st.assignedAgent = 'executor'
        if (!lower.includes('web_search')) {
          st.description += '\n\nUse the web_search tool to find this information online. If you need more detail from a specific page, use the webpage_fetch tool.'
        }
        modified = true
      }

      // File/shell subtasks → executor
      const needsFileOps =
        /\b(read|write|create|delete|move|rename)\s+(the\s+)?(file|dir|folder)/.test(lower) ||
        /\blist\s+(files|dir)/.test(lower) ||
        /\b(shell|command|terminal|git\s|npm\s|pip\s|run\s|execute)\b/.test(lower)

      if (needsFileOps && !['executor', 'coder'].includes(st.assignedAgent)) {
        console.log(`[Orchestrator] \u{1F6E1} Plan guard: subtask "${st.id}" needs file/shell — ${st.assignedAgent} → executor`)
        st.assignedAgent = 'executor'
        modified = true
      }
    }

    if (modified) {
      plan.requiredAgents = [...new Set(plan.subTasks.map(st => st.assignedAgent))]
    }
  }

  /**
   * Augment task description with tool hints when routing to executor.
   * Helps the executor LLM know which tool to use without guessing.
   */
  private augmentTaskForAgent(description: string, agent: AgentType, toolingNeeds?: TriageResult['toolingNeeds']): string {
    if (agent !== 'executor') return description

    // Use toolingNeeds (from triage LLM) to add precise tool hints
    if (toolingNeeds?.webSearch && !description.toLowerCase().includes('web_search')) {
      return description + '\n\nUse the web_search tool to find this information online. If you need to read a specific page in detail, use the webpage_fetch tool.'
    }

    return description
  }

  /** Mark a task as failed */
  private failTask(task: TaskRecord, error: string): void {
    task.status = 'failed'
    task.error = error
    this.db.run(
      `UPDATE tasks SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      error,
      task.id
    )
    this.bus.emitEvent('task:failed', { taskId: task.id, error })
  }
}

// ─── Types ──────────────────────────────────────────────────

export type AgentExecutorFn = (subTask: SubTask, context: AgentContext) => Promise<AgentResult>

// ─── Singleton ──────────────────────────────────────────────

let instance: Orchestrator | null = null

export function getOrchestrator(): Orchestrator {
  if (!instance) {
    instance = new Orchestrator()
  }
  return instance
}
