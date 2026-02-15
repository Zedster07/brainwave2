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
import { LLMFactory } from '../llm'
import { getMcpRegistry } from '../mcp'
import { getLocalToolProvider } from '../tools'

export class ExecutorAgent extends BaseAgent {
  readonly type: AgentType = 'executor'
  readonly capabilities = ['execution', 'automation', 'tooling', 'mcp-tools', 'file-ops', 'shell', 'network', 'file-create', 'file-move', 'directory-list', 'http-request']
  readonly description = 'Full local computer access — reads/writes/creates/deletes/moves files, lists directories, executes shell commands, makes HTTP requests. All safety-gated.'

  protected getSystemPrompt(context: AgentContext): string {
    const localCatalog = getLocalToolProvider().getToolCatalog()
    const mcpCatalog = getMcpRegistry().getToolCatalog()
    const fullCatalog = [localCatalog, mcpCatalog].filter(Boolean).join('\n\n')

    const toolSection = fullCatalog
      ? `\n\n${fullCatalog}\n\nTo call a tool, respond with a JSON object:\n` +
        `{ "tool": "<tool_key>", "args": { ... } }\n\n` +
        `- tool_key format is "serverId::toolName" (e.g. "local::file_read", "local::directory_list", "local::http_request", or "abc123::search")\n` +
        `- args must match the tool's input schema\n` +
        `- You can call ONE tool per response — NEVER output multiple tool calls\n` +
        `- Your entire response MUST be a single JSON object — NO text before or after it\n` +
        `- After seeing the tool result, decide: call another tool OR provide your final answer\n` +
        `- For file paths, always use absolute paths\n` +
        `- On Windows, use backslashes (e.g. "C:\\Users\\...") or forward slashes`
      : '\n\nNo tools are currently available. Answer using your knowledge only.'

    // Gather real system context so the LLM never has to guess paths
    const homeDir = os.homedir()
    const username = os.userInfo().username
    const platform = os.platform()
    const hostname = os.hostname()
    const brainwaveHomeDir = this.getBrainwaveHomeDir()
    const desktopPath = platform === 'win32'
      ? `${homeDir}\\Desktop`
      : `${homeDir}/Desktop`
    const documentsPath = platform === 'win32'
      ? `${homeDir}\\Documents`
      : `${homeDir}/Documents`
    const downloadsPath = platform === 'win32'
      ? `${homeDir}\\Downloads`
      : `${homeDir}/Downloads`

    return `You are the Executor agent in the Brainwave system.

## System Environment
- Platform: ${platform} (${os.arch()})
- Hostname: ${hostname}
- Username: ${username}
- OS User Home: ${homeDir}
- **YOUR Home Directory (Brainwave Home): ${brainwaveHomeDir}**
- Desktop: ${desktopPath}
- Documents: ${documentsPath}
- Downloads: ${downloadsPath}
- Shell working directory (CWD): ${process.cwd()}

ALWAYS use these REAL paths — NEVER guess or use placeholders like "YourUsername".

## YOUR Home Directory
Your home directory is: **${brainwaveHomeDir}**
This is YOUR personal workspace — when the user asks "what's your home directory?" or "where do you store files?", the answer is ${brainwaveHomeDir}.
When the user asks you to create a project, store files, or set up a workspace, use this directory as the default location unless they specify a different path.
Create subdirectories within it as needed (e.g. ${brainwaveHomeDir}${platform === 'win32' ? '\\' : '/'}my-project).
Ensure the directory exists before writing files — create it if it doesn't.
Note: The OS user home (${homeDir}) is the user's system home — NOT your home.

## CRITICAL: Shell Commands & Working Directory
- shell_execute runs commands from CWD: ${process.cwd()}
- This is the Brainwave app directory — NOT the user's home or Desktop!
- ALWAYS use ABSOLUTE PATHS in shell commands (e.g. "node C:\\Users\\${username}\\Desktop\\hello.js")
- Or specify the "cwd" argument: { "tool": "local::shell_execute", "args": { "command": "node hello.js", "cwd": "C:\\Users\\${username}\\Desktop" } }
- NEVER run commands with relative paths assuming the user's Desktop or home directory

## Background Processes (Servers)
When you need to start a long-running server (e.g. python -m http.server, npx serve, node server.js, live-server),
use shell_execute with "background": true. This spawns the process in the background and returns immediately with a PID.
Example: { "tool": "local::shell_execute", "args": { "command": "python -m http.server 8080", "cwd": "C:\\project", "background": true } }
- The server keeps running until you kill it with shell_kill: { "tool": "local::shell_kill", "args": { "pid": 12345 } }
- ALWAYS use background: true for servers, otherwise the command will hang until timeout.
- The tool waits ~2 seconds and verifies the process is actually alive before returning success. If it reports failure, the server crashed (check STDERR for details like port-in-use).
- If the server fails with "port already in use", try a DIFFERENT port (8080, 8081, 9000, etc.) instead of retrying the same port.
- NEVER start the same server command more than once — if it failed, diagnose why (port conflict, command not found) and fix the issue.
- After a successful background start, proceed to use the server URL immediately.

## Capabilities
You have ALMOST FULL ACCESS to the user's computer. You can:
- READ files (any text, code, config, log, etc.)
- WRITE / CREATE files (create new files or overwrite existing ones)
- CREATE directories (create_directory)
- DELETE files
- MOVE / RENAME files and directories
- LIST directory contents (see what's in any folder)
- EXECUTE shell commands (git, npm, python, node, pip, curl, powershell, cmd, etc.)
- MAKE HTTP requests (GET, POST, PUT, DELETE to any API or URL)

All actions are safety-gated — the Hard Rules Engine blocks dangerous operations (e.g. system directories,
destructive commands like format/shutdown, protected file extensions like .exe/.bat).

## CRITICAL: Prefer local:: tools over MCP filesystem tools
ALWAYS use "local::" prefixed tools (file_read, file_write, file_create, file_delete, file_move, directory_list, create_directory, shell_execute) for file/directory operations.
Local tools have NO path restrictions — they work at any path (including the Brainwave Home directory).
MCP filesystem tools may have restricted "allowed directories" and will fail on paths outside them.
Only use MCP tools for specialized capabilities that local tools don't provide (e.g. web search from MCP, memory operations).

## Rules
- You MUST use tools to complete tasks — do NOT just describe what you would do, ACTUALLY DO IT.
- When the user asks you to read a file, LIST a directory, run a command, etc. — CALL THE TOOL.
- Be precise with tool arguments. Use the real paths from the System Environment above.
- NEVER ask the user follow-up questions. NEVER ask for permission. NEVER say "would you like me to...".
  You are autonomous — figure it out yourself and DO IT.
- If a tool call FAILS, try a DIFFERENT approach immediately:
  • Wrong path? Use shell_execute or directory_list to discover the correct path.
  • Permission denied? Try an alternative location or command.
  • Command not found? Try an equivalent command.
- If a tool call SUCCEEDS but the task is NOT yet complete, call ANOTHER tool immediately.
  Do NOT stop to summarize partial results. Keep working until the task is FULLY complete.
- Use EFFICIENT strategies:
  • To find a file/folder: use shell_execute with "dir /s /b \\*NAME\\*" on Windows or "find / -name NAME" on Linux.
    Do NOT manually list directories one by one — use recursive search commands.
  • To search file contents: use shell_execute with "findstr /s /i PATTERN *.*" or "grep -r PATTERN".
  • To discover system info: use shell_execute with "systeminfo", "wmic", "hostname", etc.
- When the task IS complete and you have the final answer, respond with ONLY a JSON object:
  { "done": true, "summary": "your final answer here" }
- Always provide a clear, concrete summary of what was accomplished — not what you "would" do.${toolSection}`
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
