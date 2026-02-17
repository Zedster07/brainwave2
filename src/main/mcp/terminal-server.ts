#!/usr/bin/env node
/**
 * Terminal MCP Server — Manages persistent terminal sessions.
 *
 * Tools:
 *   terminal_execute  — Create a terminal session and run a command (foreground or background)
 *   terminal_read     — Read buffered output from a running/completed session
 *   terminal_write    — Send input (stdin) to a running session
 *   terminal_kill     — Kill a running session
 *   terminal_list     — List all active sessions
 *
 * Each session keeps a ring buffer (~100KB) of stdout/stderr so the agent
 * can check output of long-running processes (servers, watchers, builds).
 *
 * Spawned as a child process via stdio transport.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { spawn, exec } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

// ─── Constants ──────────────────────────────────────────────

/** Maximum output buffer per session (bytes) */
const MAX_BUFFER_SIZE = 100_000
/** Default timeout for foreground commands (ms) */
const DEFAULT_TIMEOUT = 30_000
/** Session auto-cleanup after exit (ms) — keep dead sessions for 10 min */
const DEAD_SESSION_TTL = 600_000

// ─── Session Management ─────────────────────────────────────

interface TerminalSession {
  id: string
  command: string
  cwd?: string
  pid: number
  process: ChildProcess | null
  stdout: string
  stderr: string
  /** Combined stdout+stderr in order received */
  output: string
  startedAt: number
  exitCode: number | null
  exited: boolean
  background: boolean
}

const sessions = new Map<string, TerminalSession>()
let sessionCounter = 0

/** Generate a short session ID */
function nextSessionId(): string {
  return `term_${++sessionCounter}`
}

/** Trim a ring buffer to MAX_BUFFER_SIZE, keeping the tail */
function trimBuffer(buf: string): string {
  if (buf.length <= MAX_BUFFER_SIZE) return buf
  return '...(truncated)...\n' + buf.slice(buf.length - MAX_BUFFER_SIZE + 20)
}

/** Clean up dead sessions older than TTL */
function cleanupDeadSessions(): void {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (session.exited && now - session.startedAt > DEAD_SESSION_TTL) {
      sessions.delete(id)
    }
  }
}

// Periodic cleanup
setInterval(cleanupDeadSessions, 60_000)

// ─── Tool Implementations ───────────────────────────────────

async function terminalExecute(args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? '').trim()
  if (!command) throw new Error('command is required')

  const cwd = args.cwd ? String(args.cwd) : undefined
  const background = args.background === true
  let timeout = typeof args.timeout === 'number' ? args.timeout : DEFAULT_TIMEOUT
  if (timeout > 0 && timeout < 1000) timeout *= 1000 // auto-fix seconds→ms

  const sessionId = nextSessionId()

  if (background) {
    // ── Background mode: spawn and keep alive ──
    const isWin = process.platform === 'win32'
    const child = spawn(
      isWin ? 'cmd' : 'sh',
      isWin ? ['/c', command] : ['-c', command],
      {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )

    const session: TerminalSession = {
      id: sessionId,
      command,
      cwd,
      pid: child.pid ?? 0,
      process: child,
      stdout: '',
      stderr: '',
      output: '',
      startedAt: Date.now(),
      exitCode: null,
      exited: false,
      background: true,
    }

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      session.stdout = trimBuffer(session.stdout + text)
      session.output = trimBuffer(session.output + text)
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      session.stderr = trimBuffer(session.stderr + text)
      session.output = trimBuffer(session.output + text)
    })

    child.on('exit', (code) => {
      session.exitCode = code
      session.exited = true
      session.process = null
    })

    child.on('error', (err) => {
      session.stderr = trimBuffer(session.stderr + `\nProcess error: ${err.message}`)
      session.output = trimBuffer(session.output + `\nProcess error: ${err.message}`)
      session.exited = true
      session.process = null
    })

    sessions.set(sessionId, session)

    // Wait briefly to detect immediate crashes
    await new Promise((r) => setTimeout(r, 1500))

    if (session.exited) {
      return JSON.stringify({
        sessionId,
        status: 'exited',
        exitCode: session.exitCode,
        output: session.output || '(no output)',
        error: 'Process exited immediately — check the command or port conflicts.',
      })
    }

    return JSON.stringify({
      sessionId,
      status: 'running',
      pid: session.pid,
      output: session.output.slice(0, 2000) || '(no output yet)',
      message: `Background session "${sessionId}" started (PID ${session.pid}). Use terminal_read to check output, terminal_write to send input, terminal_kill to stop.`,
    })
  }

  // ── Foreground mode: exec with timeout, wait for completion ──
  return new Promise<string>((resolve) => {
    const session: TerminalSession = {
      id: sessionId,
      command,
      cwd,
      pid: 0,
      process: null,
      stdout: '',
      stderr: '',
      output: '',
      startedAt: Date.now(),
      exitCode: null,
      exited: false,
      background: false,
    }
    sessions.set(sessionId, session)

    exec(
      command,
      { cwd, timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        session.stdout = trimBuffer(stdout ?? '')
        session.stderr = trimBuffer(stderr ?? '')
        session.output = trimBuffer((stdout ?? '') + (stderr ? `\nSTDERR:\n${stderr}` : ''))
        session.exited = true

        if (error) {
          const isTimeout = error.killed
          session.exitCode = typeof error.code === 'number' ? error.code : 1
          resolve(JSON.stringify({
            sessionId,
            status: 'error',
            exitCode: session.exitCode,
            timedOut: isTimeout,
            output: session.output || error.message,
          }))
        } else {
          session.exitCode = 0
          resolve(JSON.stringify({
            sessionId,
            status: 'completed',
            exitCode: 0,
            output: session.output || '(no output)',
          }))
        }
      },
    )
  })
}

function terminalRead(args: Record<string, unknown>): string {
  const sessionId = String(args.session_id ?? '').trim()
  if (!sessionId) throw new Error('session_id is required')

  const session = sessions.get(sessionId)
  if (!session) {
    // Check if any session matches by partial ID
    const match = [...sessions.values()].find((s) => s.id.includes(sessionId))
    if (!match) throw new Error(`Session "${sessionId}" not found. Use terminal_list to see active sessions.`)
    return formatSessionOutput(match, args)
  }

  return formatSessionOutput(session, args)
}

function formatSessionOutput(session: TerminalSession, args: Record<string, unknown>): string {
  const lastN = typeof args.last_n_lines === 'number' ? args.last_n_lines : undefined

  let output = session.output || '(no output)'
  if (lastN && lastN > 0) {
    const lines = output.split('\n')
    output = lines.slice(-lastN).join('\n')
  }

  return JSON.stringify({
    sessionId: session.id,
    command: session.command,
    status: session.exited ? 'exited' : 'running',
    exitCode: session.exitCode,
    pid: session.pid,
    runningSince: new Date(session.startedAt).toISOString(),
    durationMs: Date.now() - session.startedAt,
    output,
  })
}

function terminalWrite(args: Record<string, unknown>): string {
  const sessionId = String(args.session_id ?? '').trim()
  const input = String(args.input ?? '')

  if (!sessionId) throw new Error('session_id is required')
  if (!input) throw new Error('input is required')

  const session = sessions.get(sessionId)
  if (!session) throw new Error(`Session "${sessionId}" not found.`)
  if (session.exited) throw new Error(`Session "${sessionId}" has already exited (code ${session.exitCode}).`)
  if (!session.process?.stdin?.writable) throw new Error(`Session "${sessionId}" stdin is not writable.`)

  session.process.stdin.write(input + '\n')

  return JSON.stringify({
    sessionId,
    status: 'input_sent',
    message: `Sent "${input.slice(0, 100)}" to session "${sessionId}".`,
  })
}

function terminalKill(args: Record<string, unknown>): string {
  const sessionId = String(args.session_id ?? '').trim()
  if (!sessionId) throw new Error('session_id is required')

  const session = sessions.get(sessionId)
  if (!session) throw new Error(`Session "${sessionId}" not found.`)

  if (session.exited) {
    return JSON.stringify({
      sessionId,
      status: 'already_exited',
      exitCode: session.exitCode,
      message: `Session "${sessionId}" already exited (code ${session.exitCode}).`,
    })
  }

  try {
    // On Windows, use taskkill for process tree; on Unix, kill process group
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(session.pid)], { windowsHide: true })
    } else {
      process.kill(-session.pid, 'SIGKILL')
    }
  } catch {
    session.process?.kill('SIGKILL')
  }

  session.exited = true
  session.exitCode = -1
  session.process = null

  return JSON.stringify({
    sessionId,
    status: 'killed',
    message: `Session "${sessionId}" (PID ${session.pid}) has been killed.`,
    output: session.output.slice(-2000) || '(no output)',
  })
}

function terminalList(): string {
  const list = [...sessions.values()].map((s) => ({
    sessionId: s.id,
    command: s.command.slice(0, 100),
    cwd: s.cwd,
    pid: s.pid,
    status: s.exited ? 'exited' : 'running',
    exitCode: s.exitCode,
    background: s.background,
    runningSince: new Date(s.startedAt).toISOString(),
    durationMs: Date.now() - s.startedAt,
    outputLength: s.output.length,
  }))

  return JSON.stringify({
    count: list.length,
    sessions: list,
  })
}

// ─── MCP Server Setup ───────────────────────────────────────

const server = new Server(
  { name: 'terminal', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

// ── List Tools ──
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'terminal_execute',
      description:
        'Execute a command in a new terminal session. Returns a session_id you can use with other terminal_* tools. ' +
        'For long-running processes (servers, watchers, builds), set background=true — the session stays alive and you can read its output anytime with terminal_read. ' +
        'IMPORTANT WORKFLOW: Every command you run here is tracked as a session. ' +
        'To find running sessions, use terminal_list (NOT netstat/ps/tasklist). ' +
        'To stop a session, use terminal_kill with the session_id (NOT taskkill/kill commands). ' +
        'To check output, use terminal_read (NOT running the command again). ' +
        'NEVER use raw shell commands (netstat, tasklist, taskkill, ps, kill) to manage sessions — always use the terminal_* tools instead.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional, defaults to home)' },
          background: {
            type: 'boolean',
            description: 'If true, run in background and return immediately. Use for servers, watchers, long builds. Default: false',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds for foreground commands. Default: 30000 (30s). Ignored for background.',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'terminal_read',
      description:
        'Read the buffered output (stdout+stderr) from a terminal session by session_id. ' +
        'Works on both running and completed sessions. Use last_n_lines to get only recent output. ' +
        'If you don\'t know the session_id, call terminal_list first — do NOT run shell commands like netstat or ps to find it.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'The session ID returned by terminal_execute' },
          last_n_lines: {
            type: 'number',
            description: 'Only return the last N lines of output. Useful for checking recent logs from a running server.',
          },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'terminal_write',
      description:
        'Send text input (stdin) to a running terminal session. Use this to interact with interactive processes, provide input to prompts, or send commands to a REPL.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'The session ID of a running session' },
          input: { type: 'string', description: 'The text to send to stdin (a newline is appended automatically)' },
        },
        required: ['session_id', 'input'],
      },
    },
    {
      name: 'terminal_kill',
      description:
        'Kill a running terminal session and all its child processes by session_id. Returns the final buffered output. ' +
        'This is THE way to stop processes — NEVER use taskkill, kill, or other shell commands to stop sessions. ' +
        'If you don\'t know the session_id, call terminal_list first.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'The session ID to kill (from terminal_execute or terminal_list, e.g. "term_1")' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'terminal_list',
      description:
        'List ALL terminal sessions (running and recently exited) with their session_id, command, PID, status, and duration. ' +
        'ALWAYS call this FIRST when you need to find, check, or manage any running process. ' +
        'Do NOT use netstat, tasklist, ps, or other shell commands to find processes — this tool already tracks everything.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}))

// ── Call Tool ──
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    let result: string

    switch (name) {
      case 'terminal_execute':
        result = await terminalExecute(args as Record<string, unknown>)
        break
      case 'terminal_read':
        result = terminalRead(args as Record<string, unknown>)
        break
      case 'terminal_write':
        result = terminalWrite(args as Record<string, unknown>)
        break
      case 'terminal_kill':
        result = terminalKill(args as Record<string, unknown>)
        break
      case 'terminal_list':
        result = terminalList()
        break
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }

    return { content: [{ type: 'text', text: result }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    }
  }
})

// ─── Start ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // eslint-disable-next-line no-console
  console.error('[Terminal MCP] Server running on stdio')
}

main().catch((err) => {
  console.error('[Terminal MCP] Fatal error:', err)
  process.exit(1)
})
