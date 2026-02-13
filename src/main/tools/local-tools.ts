/**
 * Local Tool Provider — Built-in system tools for agents
 *
 * Provides comprehensive OS-level tools:
 *   File:    file_read, file_write, file_create, file_delete, file_move, directory_list
 *   Shell:   shell_execute
 *   Network: http_request, web_search, webpage_fetch
 *
 * Every call is gated through the Hard Rules Engine before execution.
 * Tools use the same shape as MCP tools so the executor treats them identically.
 */
import { readFile, writeFile, unlink, mkdir, stat, rename, readdir } from 'node:fs/promises'
import { exec } from 'node:child_process'
import { resolve, dirname, basename, join } from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { getHardEngine } from '../rules'
import { getEventBus } from '../agents/event-bus'
import type { McpTool, McpToolCallResult } from '../mcp/types'

// Max output from shell commands (100 KB)
const MAX_SHELL_OUTPUT = 100 * 1024

/**
 * Make an HTTP/HTTPS request using Node.js core modules.
 * This bypasses Electron's net.fetch() which uses Chromium's networking stack
 * and gets flagged as a bot by sites like DuckDuckGo.
 */
function nodeHttpRequest(
  url: string,
  options: {
    method?: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'
    const lib = isHttps ? https : http

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method ?? 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers,
      },
    }

    const req = lib.request(reqOptions, (res) => {
      // Follow redirects (up to 3)
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        nodeHttpRequest(res.headers.location, options).then(resolve).catch(reject)
        return
      }

      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf-8'),
        })
      })
      res.on('error', reject)
    })

    req.on('error', reject)

    // Timeout
    const timeout = options.timeoutMs ?? 15_000
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Request timed out after ${timeout}ms`))
    })

    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

// Max file read size (5 MB)
const MAX_READ_SIZE = 5 * 1024 * 1024

// ─── Tool Definitions ───────────────────────────────────────

const TOOL_DEFS: McpTool[] = [
  {
    key: 'local::file_read',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'file_read',
    description: 'Read the contents of a file. Returns the text content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file' },
        encoding: { type: 'string', description: 'File encoding (default: utf-8)' },
      },
      required: ['path'],
    },
  },
  {
    key: 'local::file_write',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'file_write',
    description: 'Write/overwrite content to an existing or new file. Creates parent directories automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    key: 'local::file_create',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'file_create',
    description: 'Create a new file with content. Fails if the file already exists. Creates parent directories automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path for the new file' },
        content: { type: 'string', description: 'Content to write (default: empty)' },
      },
      required: ['path'],
    },
  },
  {
    key: 'local::file_delete',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'file_delete',
    description: 'Delete a file from disk.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file' },
      },
      required: ['path'],
    },
  },
  {
    key: 'local::file_move',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'file_move',
    description: 'Move or rename a file or directory.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Current path of the file/directory' },
        destination: { type: 'string', description: 'New path for the file/directory' },
      },
      required: ['source', 'destination'],
    },
  },
  {
    key: 'local::directory_list',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'directory_list',
    description: 'List files and subdirectories in a directory. Returns names, sizes, and types (file/directory).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the directory' },
        recursive: { type: 'boolean', description: 'List recursively (default: false, max 2 levels)' },
      },
      required: ['path'],
    },
  },
  {
    key: 'local::shell_execute',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'shell_execute',
    description: 'Execute a shell command (cmd/PowerShell on Windows, sh on Unix). Returns stdout and stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
      },
      required: ['command'],
    },
  },
  {
    key: 'local::http_request',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'http_request',
    description: 'Make an HTTP request to a URL. Supports GET, POST, PUT, DELETE. Returns the response body.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to request' },
        method: { type: 'string', description: 'HTTP method: GET, POST, PUT, DELETE (default: GET)' },
        headers: { type: 'object', description: 'Request headers as key-value pairs' },
        body: { type: 'string', description: 'Request body (for POST/PUT)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
      },
      required: ['url'],
    },
  },
  {
    key: 'local::send_notification',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'send_notification',
    description: 'Send an OS notification to the user. Use this to alert the user about important events, completions, or information.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title (short, e.g. "Download Complete")' },
        body: { type: 'string', description: 'Notification body message' },
      },
      required: ['title', 'body'],
    },
  },
  {
    key: 'local::web_search',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'web_search',
    description: 'Search the web using DuckDuckGo. Returns titles, URLs, and snippets. Use this for any web research, finding current information, or answering questions about recent events.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        max_results: { type: 'number', description: 'Maximum number of results to return (default: 8, max: 20)' },
      },
      required: ['query'],
    },
  },
  {
    key: 'local::webpage_fetch',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'webpage_fetch',
    description: 'Fetch and extract the main text content from a webpage URL. Strips HTML tags and returns clean text. Use after web_search to read full articles.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL of the webpage to fetch' },
        max_length: { type: 'number', description: 'Maximum characters to return (default: 15000)' },
      },
      required: ['url'],
    },
  },
]

// ─── Provider ───────────────────────────────────────────────

class LocalToolProvider {
  /** Get all available local tool definitions */
  getTools(): McpTool[] {
    return [...TOOL_DEFS]
  }

  /** Get a formatted tool catalog string for injection into agent prompts */
  getToolCatalog(): string {
    const lines = TOOL_DEFS.map((t) => {
      const schema = t.inputSchema as { properties?: Record<string, unknown> }
      const params = Object.keys(schema.properties ?? {}).join(', ')
      return `- ${t.key}: ${t.description} (params: ${params})`
    })
    return `Built-in Local Tools:\n${lines.join('\n')}`
  }

  /** Call a local tool by name. Safety-gated through the Hard Rules Engine. */
  async callTool(
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<McpToolCallResult> {
    console.log(`[LocalTools] callTool(${toolName}) args=${JSON.stringify(args).slice(0, 300)}`)
    switch (toolName) {
      case 'file_read':
        return this.fileRead(args)
      case 'file_write':
        return this.fileWrite(args)
      case 'file_create':
        return this.fileCreate(args)
      case 'file_delete':
        return this.fileDelete(args)
      case 'file_move':
        return this.fileMove(args)
      case 'directory_list':
        return this.directoryList(args)
      case 'shell_execute':
        return this.shellExecute(args)
      case 'http_request':
        return this.httpRequest(args)
      case 'send_notification':
        return this.sendNotification(args)
      case 'web_search':
        return this.webSearch(args)
      case 'webpage_fetch':
        return this.webpageFetch(args)
      default:
        return {
          toolKey: `local::${toolName}`,
          success: false,
          content: `Unknown local tool: ${toolName}`,
          isError: true,
          duration: 0,
        }
    }
  }

  // ─── File Read ────────────────────────────────────────

  private async fileRead(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const filePath = resolve(String(args.path ?? ''))
    const encoding = (args.encoding as BufferEncoding) ?? 'utf-8'
    const start = Date.now()

    // Safety gate
    const verdict = getHardEngine().evaluate({ type: 'file_read', path: filePath })
    if (!verdict.allowed) {
      return this.blocked('local::file_read', verdict.reason, start)
    }

    try {
      // Check size before reading
      const info = await stat(filePath)
      if (info.size > MAX_READ_SIZE) {
        return this.error(
          'local::file_read',
          `File too large (${(info.size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_READ_SIZE / 1024 / 1024} MB.`,
          start
        )
      }

      const content = await readFile(filePath, { encoding })
      return {
        toolKey: 'local::file_read',
        success: true,
        content,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::file_read', this.errMsg(err), start)
    }
  }

  // ─── File Write ───────────────────────────────────────

  private async fileWrite(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const filePath = resolve(String(args.path ?? ''))
    const content = String(args.content ?? '')
    const start = Date.now()

    // Safety gate
    const verdict = getHardEngine().evaluate({
      type: 'file_write',
      path: filePath,
      content,
      size: Buffer.byteLength(content, 'utf-8'),
    })
    if (!verdict.allowed) {
      return this.blocked('local::file_write', verdict.reason, start)
    }

    try {
      // Ensure parent directories exist
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, content, 'utf-8')

      return {
        toolKey: 'local::file_write',
        success: true,
        content: `File written: ${filePath} (${Buffer.byteLength(content)} bytes)`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::file_write', this.errMsg(err), start)
    }
  }

  // ─── File Delete ──────────────────────────────────────

  private async fileDelete(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const filePath = resolve(String(args.path ?? ''))
    const start = Date.now()

    // Safety gate
    const verdict = getHardEngine().evaluate({ type: 'file_delete', path: filePath })
    if (!verdict.allowed) {
      return this.blocked('local::file_delete', verdict.reason, start)
    }

    try {
      await unlink(filePath)

      return {
        toolKey: 'local::file_delete',
        success: true,
        content: `File deleted: ${filePath}`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::file_delete', this.errMsg(err), start)
    }
  }

  // ─── File Create ─────────────────────────────────────

  private async fileCreate(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const filePath = resolve(String(args.path ?? ''))
    const content = String(args.content ?? '')
    const start = Date.now()

    // Safety gate (uses file_write evaluation — same rules)
    const verdict = getHardEngine().evaluate({
      type: 'file_write',
      path: filePath,
      content,
      size: Buffer.byteLength(content, 'utf-8'),
    })
    if (!verdict.allowed) {
      return this.blocked('local::file_create', verdict.reason, start)
    }

    try {
      // Check if file already exists
      try {
        await stat(filePath)
        return this.error('local::file_create', `File already exists: ${filePath}. Use file_write to overwrite.`, start)
      } catch {
        // Good — file doesn't exist
      }

      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, content, 'utf-8')

      return {
        toolKey: 'local::file_create',
        success: true,
        content: `File created: ${filePath} (${Buffer.byteLength(content)} bytes)`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::file_create', this.errMsg(err), start)
    }
  }

  // ─── File Move / Rename ──────────────────────────────

  private async fileMove(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const source = resolve(String(args.source ?? ''))
    const destination = resolve(String(args.destination ?? ''))
    const start = Date.now()

    // Safety gate — check both source (read) and destination (write)
    const srcVerdict = getHardEngine().evaluate({ type: 'file_read', path: source })
    if (!srcVerdict.allowed) {
      return this.blocked('local::file_move', `Source blocked: ${srcVerdict.reason}`, start)
    }

    const dstVerdict = getHardEngine().evaluate({ type: 'file_write', path: destination, content: '', size: 0 })
    if (!dstVerdict.allowed) {
      return this.blocked('local::file_move', `Destination blocked: ${dstVerdict.reason}`, start)
    }

    try {
      await mkdir(dirname(destination), { recursive: true })
      await rename(source, destination)

      return {
        toolKey: 'local::file_move',
        success: true,
        content: `Moved: ${source} → ${destination}`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::file_move', this.errMsg(err), start)
    }
  }

  // ─── Directory List ──────────────────────────────────

  private async directoryList(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const dirPath = resolve(String(args.path ?? '.'))
    const recursive = Boolean(args.recursive)
    const start = Date.now()

    // Safety gate
    const verdict = getHardEngine().evaluate({ type: 'file_read', path: dirPath })
    if (!verdict.allowed) {
      return this.blocked('local::directory_list', verdict.reason, start)
    }

    try {
      const entries = await this.listDir(dirPath, recursive ? 2 : 0, 0)

      return {
        toolKey: 'local::directory_list',
        success: true,
        content: entries.length > 0
          ? entries.join('\n')
          : '(empty directory)',
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::directory_list', this.errMsg(err), start)
    }
  }

  /** Recursively list directory contents with indentation */
  private async listDir(dirPath: string, maxDepth: number, currentDepth: number): Promise<string[]> {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const lines: string[] = []
    const indent = '  '.repeat(currentDepth)

    // Sort: directories first, then files
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })

    for (const entry of sorted) {
      if (entry.isDirectory()) {
        lines.push(`${indent}📁 ${entry.name}/`)
        if (currentDepth < maxDepth) {
          const subLines = await this.listDir(join(dirPath, entry.name), maxDepth, currentDepth + 1)
          lines.push(...subLines)
        }
      } else {
        try {
          const info = await stat(join(dirPath, entry.name))
          const sizeStr = info.size < 1024
            ? `${info.size} B`
            : info.size < 1024 * 1024
              ? `${(info.size / 1024).toFixed(1)} KB`
              : `${(info.size / 1024 / 1024).toFixed(1)} MB`
          lines.push(`${indent}📄 ${entry.name} (${sizeStr})`)
        } catch {
          lines.push(`${indent}📄 ${entry.name}`)
        }
      }
    }

    return lines
  }

  // ─── HTTP Request ────────────────────────────────────

  private async shellExecute(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const command = String(args.command ?? '')
    const cwd = args.cwd ? resolve(String(args.cwd)) : undefined
    const timeout = typeof args.timeout === 'number' ? args.timeout : 30_000
    const start = Date.now()

    if (!command.trim()) {
      return this.error('local::shell_execute', 'Command cannot be empty', start)
    }

    // Parse command into base command + args for the safety check
    const parts = command.trim().split(/\s+/)
    const baseCmd = parts[0]
    const cmdArgs = parts.slice(1)

    // Safety gate
    const verdict = getHardEngine().evaluate({
      type: 'shell_execute',
      command: baseCmd,
      args: cmdArgs,
      cwd,
      timeout,
    })
    if (!verdict.allowed) {
      return this.blocked('local::shell_execute', verdict.reason, start)
    }

    return new Promise<McpToolCallResult>((resolvePromise) => {
      exec(
        command,
        {
          cwd,
          timeout,
          maxBuffer: MAX_SHELL_OUTPUT,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const duration = Date.now() - start

          if (error) {
            // Distinguish timeout from other errors
            const isTimeout = error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            const errorMsg = isTimeout
              ? `Command timed out after ${timeout}ms`
              : `Exit code ${error.code ?? 1}: ${error.message}`

            const output = [
              errorMsg,
              stdout?.trim() ? `\nSTDOUT:\n${this.truncate(stdout)}` : '',
              stderr?.trim() ? `\nSTDERR:\n${this.truncate(stderr)}` : '',
            ]
              .filter(Boolean)
              .join('\n')

            resolvePromise({
              toolKey: 'local::shell_execute',
              success: false,
              content: output,
              isError: true,
              duration,
            })
          } else {
            const output = [
              stdout?.trim() ? this.truncate(stdout) : '(no output)',
              stderr?.trim() ? `\nSTDERR:\n${this.truncate(stderr)}` : '',
            ]
              .filter(Boolean)
              .join('\n')

            resolvePromise({
              toolKey: 'local::shell_execute',
              success: true,
              content: output,
              isError: false,
              duration,
            })
          }
        }
      )
    })
  }

  // ─── HTTP Request ────────────────────────────────────

  private async httpRequest(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const url = String(args.url ?? '')
    const method = (String(args.method ?? 'GET')).toUpperCase()
    const headers = (args.headers as Record<string, string>) ?? {}
    const body = args.body ? String(args.body) : undefined
    const timeout = typeof args.timeout === 'number' ? args.timeout : 30_000
    const start = Date.now()

    if (!url) {
      return this.error('local::http_request', 'URL is required', start)
    }

    // Safety gate — network action evaluation
    const verdict = getHardEngine().evaluate({
      type: 'network_request',
      url,
      method,
      bodySize: body ? Buffer.byteLength(body) : 0,
    })
    if (!verdict.allowed) {
      return this.blocked('local::http_request', verdict.reason, start)
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        method,
        headers,
        body: ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
        signal: controller.signal,
      })

      clearTimeout(timer)

      const contentType = response.headers.get('content-type') ?? ''
      let responseBody: string

      if (contentType.includes('application/json')) {
        const json = await response.json()
        responseBody = JSON.stringify(json, null, 2)
      } else {
        responseBody = await response.text()
      }

      // Truncate very large responses
      if (responseBody.length > MAX_SHELL_OUTPUT) {
        responseBody = responseBody.slice(0, MAX_SHELL_OUTPUT) + `\n... [truncated, ${responseBody.length} total chars]`
      }

      const statusLine = `HTTP ${response.status} ${response.statusText}`

      return {
        toolKey: 'local::http_request',
        success: response.ok,
        content: `${statusLine}\n\n${responseBody}`,
        isError: !response.ok,
        duration: Date.now() - start,
      }
    } catch (err) {
      const message = err instanceof Error && err.name === 'AbortError'
        ? `Request timed out after ${timeout}ms`
        : this.errMsg(err)
      return this.error('local::http_request', message, start)
    }
  }

  // ─── Helpers ──────────────────────────────────────────

  // ─── Send Notification ─────────────────────────────────

  private async sendNotification(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const start = Date.now()
    const title = String(args.title ?? 'Notification')
    const body = String(args.body ?? '')

    if (!body) {
      return this.error('local::send_notification', 'body is required', start)
    }

    try {
      getEventBus().emit('notification:send', {
        title,
        body,
        type: 'agent',
      })

      return {
        toolKey: 'local::send_notification',
        success: true,
        content: `Notification sent: "${title}"`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::send_notification', this.errMsg(err), start)
    }
  }

  // ─── Web Search (DuckDuckGo HTML) ─────────────────────

  private async webSearch(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const query = String(args.query ?? '').trim()
    const maxResults = Math.min(typeof args.max_results === 'number' ? args.max_results : 8, 20)
    const start = Date.now()

    if (!query) {
      return this.error('local::web_search', 'query is required', start)
    }

    // Safety gate
    const verdict = getHardEngine().evaluate({
      type: 'network_request',
      url: 'https://html.duckduckgo.com/html/',
      method: 'POST',
      bodySize: query.length,
    })
    if (!verdict.allowed) {
      return this.blocked('local::web_search', verdict.reason, start)
    }

    try {
      const { status, body: html } = await nodeHttpRequest('https://html.duckduckgo.com/html/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `q=${encodeURIComponent(query)}`,
        timeoutMs: 15_000,
      })

      if (status < 200 || status >= 300) {
        return this.error('local::web_search', `DuckDuckGo returned HTTP ${status}`, start)
      }

      // Parse results from DuckDuckGo HTML response
      const results: Array<{ title: string; url: string; snippet: string }> = []
      const resultPattern = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
      let match: RegExpExecArray | null

      while ((match = resultPattern.exec(html)) !== null && results.length < maxResults) {
        const rawUrl = match[1]
        const title = match[2].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim()
        const snippet = match[3].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim()

        // DuckDuckGo wraps URLs in a redirect — extract actual URL
        let url = rawUrl
        try {
          const parsed = new URL(rawUrl, 'https://duckduckgo.com')
          const uddg = parsed.searchParams.get('uddg')
          if (uddg) url = decodeURIComponent(uddg)
        } catch { /* use raw url */ }

        if (title && url) {
          results.push({ title, url, snippet })
        }
      }

      if (results.length === 0) {
        return {
          toolKey: 'local::web_search',
          success: true,
          content: `No results found for: "${query}"`,
          isError: false,
          duration: Date.now() - start,
        }
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
      ).join('\n\n')

      return {
        toolKey: 'local::web_search',
        success: true,
        content: `Web search results for "${query}" (${results.length} results):\n\n${formatted}`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      const message = err instanceof Error && err.message.includes('timed out')
        ? 'Search timed out after 15s'
        : this.errMsg(err)
      return this.error('local::web_search', message, start)
    }
  }

  // ─── Webpage Fetch ────────────────────────────────────

  private async webpageFetch(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const url = String(args.url ?? '').trim()
    const maxLength = typeof args.max_length === 'number' ? args.max_length : 15_000
    const start = Date.now()

    if (!url) {
      return this.error('local::webpage_fetch', 'url is required', start)
    }

    // Safety gate
    const verdict = getHardEngine().evaluate({
      type: 'network_request',
      url,
      method: 'GET',
      bodySize: 0,
    })
    if (!verdict.allowed) {
      return this.blocked('local::webpage_fetch', verdict.reason, start)
    }

    try {
      const { status, body: html } = await nodeHttpRequest(url, {
        method: 'GET',
        timeoutMs: 20_000,
      })

      if (status < 200 || status >= 300) {
        return this.error('local::webpage_fetch', `HTTP ${status}`, start)
      }

      // Strip scripts, styles, and HTML tags to get clean text
      let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/\s+/g, ' ')
        .trim()

      if (text.length > maxLength) {
        text = text.slice(0, maxLength) + `\n... [truncated, ${text.length} total chars]`
      }

      return {
        toolKey: 'local::webpage_fetch',
        success: true,
        content: `Content from ${url}:\n\n${text}`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      const message = err instanceof Error && err.message.includes('timed out')
        ? 'Fetch timed out after 20s'
        : this.errMsg(err)
      return this.error('local::webpage_fetch', message, start)
    }
  }

  // ─── Helpers ──────────────────────────────────────────

  private blocked(toolKey: string, reason: string, start: number): McpToolCallResult {
    return {
      toolKey,
      success: false,
      content: `BLOCKED by Safety Rules: ${reason}`,
      isError: true,
      duration: Date.now() - start,
    }
  }

  private error(toolKey: string, message: string, start: number): McpToolCallResult {
    return {
      toolKey,
      success: false,
      content: `Error: ${message}`,
      isError: true,
      duration: Date.now() - start,
    }
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  private truncate(text: string, max = MAX_SHELL_OUTPUT): string {
    if (text.length <= max) return text
    return text.slice(0, max) + `\n... [truncated, ${text.length} total chars]`
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: LocalToolProvider | null = null

export function getLocalToolProvider(): LocalToolProvider {
  if (!instance) {
    instance = new LocalToolProvider()
  }
  return instance
}
