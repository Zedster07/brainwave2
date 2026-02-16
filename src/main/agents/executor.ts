/**
 * Executor Agent — Calls tools to perform real-world actions
 *
 * When the planner assigns a task to the executor, this agent:
 * 1. Reviews available tools (built-in local tools + MCP tools)
 * 2. Uses the LLM to decide which tool to call and with what arguments
 * 3. Calls the tool via the local provider or MCP registry
 * 4. Returns the results as an AgentResult
 *
 * Built-in local tools: file_read, file_write, file_delete, shell_execute
 * All local tool calls are gated through the Hard Rules Engine.
 *
 * Uses the shared agentic tool loop from BaseAgent.executeWithTools().
 */
import os from 'os'
import type { AgentType } from './event-bus'
import { BaseAgent, type SubTask, type AgentContext, type AgentResult } from './base-agent'
import { buildSystemEnvironmentBlock } from './environment'
import { getMcpRegistry } from '../mcp'
import { getLocalToolProvider } from '../tools'

export class ExecutorAgent extends BaseAgent {
  readonly type: AgentType = 'executor'
  readonly capabilities = ['execution', 'automation', 'tooling', 'mcp-tools', 'file-ops', 'shell', 'network', 'file-create', 'file-move', 'directory-list', 'http-request']
  readonly description = 'Full local computer access — reads/writes/creates/deletes/moves files, lists directories, executes shell commands, makes HTTP requests. All safety-gated.'

  protected getSystemPrompt(context: AgentContext): string {
    // Use the shared buildToolSection for consistent tool catalog formatting
    const toolSection = this.buildToolSection(context.mode)

    // Gather real system context
    const brainwaveHomeDir = this.getBrainwaveHomeDir()
    const username = os.userInfo().username
    const platform = os.platform()
    const systemEnv = buildSystemEnvironmentBlock(brainwaveHomeDir)

    return `You are Brainwave, an autonomous software engineer with full access to the user's computer.

${systemEnv}

## Thinking
Before each action, briefly reason about:
- What you know about the task so far
- What the most efficient approach is
- What could go wrong and how to handle it
Write your reasoning as plain text before making tool calls.

## Shell Command Rules
- shell_execute runs commands from CWD: ${process.cwd()} — this is the Brainwave app directory, NOT the user's project
- ALWAYS use ABSOLUTE PATHS or specify the "cwd" argument for shell commands
- Check the OS platform (${platform}) before using OS-specific commands
- Use cross-platform commands when possible
- For long-running commands (servers, builds), use background: true
- Do NOT run commands that require user input (interactive prompts)
- Check command exit codes and handle errors

## Background Processes
When starting servers (python -m http.server, npx serve, node server.js, etc.):
- Use shell_execute with "background": true — returns immediately with PID
- Kill with shell_kill when done
- If "port already in use", try a DIFFERENT port instead of retrying
- NEVER start the same server twice — diagnose failures first

## Capabilities
You have ALMOST FULL ACCESS to the user's computer:
- Read, write, create, delete, move, rename files and directories
- Execute shell commands (git, npm, python, node, pip, curl, etc.)
- Make HTTP requests (GET, POST, PUT, DELETE)
- All actions are safety-gated by the Hard Rules Engine

## Tool Preferences
- ALWAYS use local:: prefixed tools for file/directory operations — they have no path restrictions
- MCP filesystem tools may have restricted "allowed directories" and will fail on paths outside them
- Only use MCP tools for specialized capabilities that local tools don't provide

## Rules
- You MUST use tools to complete tasks — ACTUALLY DO IT, don't just describe what you would do
- You are autonomous — NEVER ask permission, NEVER say "would you like me to..."
- If a tool call FAILS, try a DIFFERENT approach immediately (different path, command, or tool)
- If a tool call SUCCEEDS but the task is NOT complete, call ANOTHER tool immediately — don't stop to summarize
- Use EFFICIENT strategies:
  • Find files: use recursive search (dir /s /b on Windows, find on Linux) — don't list dirs one by one
  • Search contents: use findstr /s /i or grep -r
- Always provide a clear, concrete summary of what was accomplished${toolSection}`
  }

  /**
   * Execute uses the shared agentic tool loop from BaseAgent.
   * If no tools are available, falls back to LLM-only reasoning.
   */
  async execute(task: SubTask, context: AgentContext): Promise<AgentResult> {
    const registry = getMcpRegistry()
    const localProvider = getLocalToolProvider()
    const allTools = [...localProvider.getTools(), ...registry.getAllTools()]

    // If no tools at all, use standard LLM-only execution
    if (allTools.length === 0) {
      return super.execute(task, context)
    }

    return this.executeWithTools(task, context)
  }
}
