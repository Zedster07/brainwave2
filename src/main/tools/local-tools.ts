/**
 * Local Tool Provider — Built-in system tools for agents
 *
 * Provides comprehensive OS-level tools:
 *   File:    file_read, file_write, file_create, file_delete, file_move, directory_list, directory_create
 *   Shell:   shell_execute
 *   Network: http_request, web_search, webpage_fetch
 *
 * Every call is gated through the Hard Rules Engine before execution.
 * Tools use the same shape as MCP tools so the executor treats them identically.
 */
import { readFile, writeFile, unlink, mkdir, stat, rename, readdir } from 'node:fs/promises'
import { exec, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { resolve, dirname, basename, join } from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { getHardEngine } from '../rules'
import { getEventBus } from '../agents/event-bus'
import type { McpTool, McpToolCallResult } from '../mcp/types'
import { getDiffStrategy, parsePatchOperations, type DiffBlock } from './diff-strategy'
import { isBinaryDocument, extractDocumentText } from './document-extractor'
import { generatePDF, generateDOCX, generateXLSX, generatePPTX } from './document-generator'


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

// ─── Tool Definitions ───────────────────────────────────────

const TOOL_DEFS: McpTool[] = [
  {
    key: 'local::file_read',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'file_read',
    description: 'Read the contents of a file. Returns text content. For large files, use start_line/end_line to read specific sections. Automatically extracts readable text from PDF, DOCX, and XLSX files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file' },
        encoding: { type: 'string', description: 'File encoding (default: utf-8)' },
        start_line: { type: 'number', description: '1-based line number to start reading from (inclusive). Omit to start from beginning.' },
        end_line: { type: 'number', description: '1-based line number to stop reading at (inclusive). Omit to read to end.' },
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
    key: 'local::create_directory',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'create_directory',
    description: 'Create a new directory (and any parent directories). Use this before writing files to a new project folder.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the directory to create' },
      },
      required: ['path'],
    },
  },
  {
    key: 'local::shell_execute',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'shell_execute',
    description: 'Execute a shell command. Returns stdout/stderr. For long-running servers (http-server, python -m http.server, etc.), set "background": true to start them detached — returns immediately with a process ID you can later kill with shell_kill.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000). Ignored if background=true.' },
        background: { type: 'boolean', description: 'If true, starts the command as a detached background process and returns immediately with a process ID. Use this for servers, watchers, and other long-running commands.' },
      },
      required: ['command'],
    },
  },
  {
    key: 'local::shell_kill',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'shell_kill',
    description: 'Kill a background process started with shell_execute(background=true). Provide the pid returned by the background shell_execute call.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'The process ID to kill' },
      },
      required: ['pid'],
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
      },
      required: ['url'],
    },
  },
  {
    key: 'local::file_edit',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'file_edit',
    description: 'Edit an existing file by replacing a specific string with new content. Supports single old_string/new_string replacement OR multiple SEARCH/REPLACE diff blocks. For small changes, use old_string/new_string. For multi-edit, pass diff_blocks as a JSON array of {search, replace} objects. Include 2-3 lines of context around the target to ensure a unique match.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'The exact text to find and replace (must match uniquely)' },
        new_string: { type: 'string', description: 'The replacement text' },
        diff_blocks: { type: 'string', description: 'JSON array of {search, replace} objects for multi-block edits' },
      },
      required: ['path'],
    },
  },
  {
    key: 'local::search_files',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'search_files',
    description: 'Search for files matching a regex pattern within a directory. Returns matching lines with file paths and line numbers. Useful for finding code patterns, function definitions, or specific strings across a project.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search in (absolute path)' },
        regex: { type: 'string', description: 'Regex pattern to search for in file contents' },
        file_pattern: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts", "*.{js,tsx}"). Default: all text files' },
      },
      required: ['path', 'regex'],
    },
  },
  {
    key: 'local::apply_patch',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'apply_patch',
    description: 'Apply a unified-diff-style patch that can update, create, or delete multiple files in one call. Use "*** Update File: path" with context/+/- lines, "*** Add File: path" with + lines, or "*** Delete File: path".',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'The unified diff patch content' },
      },
      required: ['diff'],
    },
  },
  {
    key: 'local::list_code_definition_names',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'list_code_definition_names',
    description: 'Parse source code files to extract top-level definitions (classes, functions, interfaces, types, exports). Shows the structure of a file or directory without reading full contents. Supports TypeScript, JavaScript, Python, Go, Rust, Java, C/C++.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a file or directory to parse' },
      },
      required: ['path'],
    },
  },
  {
    key: 'local::ask_followup_question',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'ask_followup_question',
    description: 'Ask the user a question to clarify requirements or get a decision before proceeding. Pauses execution until the user responds. Optionally provide quick-select options.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
        options: { type: 'string', description: 'JSON array of option strings for quick selection (optional)' },
      },
      required: ['question'],
    },
  },
  {
    key: 'local::condense',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'condense',
    description: 'Condense the conversation history to free up context window space. Use when you notice the context is getting large or you\'re running low on tokens. Preserves key information while reducing token usage.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // ─── Document Generation Tools ───
  {
    key: 'local::generate_pdf',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'generate_pdf',
    description: 'Generate a PDF document. Provide structured content with sections (heading, body, bullets) and optional tables. The file is written to the specified output path.',
    inputSchema: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Absolute path for the output PDF file (e.g. /path/to/report.pdf)' },
        title: { type: 'string', description: 'Document title (centered at top)' },
        author: { type: 'string', description: 'Document author metadata' },
        sections: { type: 'string', description: 'JSON array of section objects: [{heading?, body?, bullets?}]' },
        tables: { type: 'string', description: 'JSON array of table objects: [{headers: string[], rows: string[][]}]' },
      },
      required: ['output_path'],
    },
  },
  {
    key: 'local::generate_docx',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'generate_docx',
    description: 'Generate a DOCX (Word) document. Provide structured content with sections (heading, body, bullets) and optional tables. The file is written to the specified output path.',
    inputSchema: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Absolute path for the output DOCX file (e.g. /path/to/report.docx)' },
        title: { type: 'string', description: 'Document title' },
        author: { type: 'string', description: 'Document author metadata' },
        sections: { type: 'string', description: 'JSON array of section objects: [{heading?, body?, bullets?}]' },
        tables: { type: 'string', description: 'JSON array of table objects: [{headers: string[], rows: string[][]}]' },
      },
      required: ['output_path'],
    },
  },
  {
    key: 'local::generate_xlsx',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'generate_xlsx',
    description: 'Generate an XLSX (Excel) spreadsheet. Provide one or more sheets, each with headers and data rows. The file is written to the specified output path.',
    inputSchema: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Absolute path for the output XLSX file (e.g. /path/to/data.xlsx)' },
        author: { type: 'string', description: 'Document author metadata' },
        sheets: { type: 'string', description: 'JSON array of sheet objects: [{name: string, headers: string[], rows: (string|number|boolean|null)[][]}]' },
      },
      required: ['output_path', 'sheets'],
    },
  },
  {
    key: 'local::generate_pptx',
    serverId: 'local',
    serverName: 'Built-in Tools',
    name: 'generate_pptx',
    description: 'Generate a PPTX (PowerPoint) presentation. Provide an array of slides, each with an optional title, body text, bullet points, table, and speaker notes. The file is written to the specified output path.',
    inputSchema: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Absolute path for the output PPTX file (e.g. /path/to/presentation.pptx)' },
        title: { type: 'string', description: 'Presentation title metadata' },
        author: { type: 'string', description: 'Document author metadata' },
        subject: { type: 'string', description: 'Presentation subject metadata' },
        slides: { type: 'string', description: 'JSON array of slide objects: [{title?: string, body?: string, bullets?: string[], notes?: string, table?: {headers: string[], rows: string[][]}}]' },
      },
      required: ['output_path', 'slides'],
    },
  },
]

// ─── Provider ───────────────────────────────────────────────

class LocalToolProvider {
  /** Background process tracker — maps PID to child process reference */
  private backgroundProcesses = new Map<number, ChildProcess>()

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
      case 'create_directory':
        return this.createDirectory(args)
      case 'shell_execute':
        return this.shellExecute(args)
      case 'shell_kill':
        return this.shellKill(args)
      case 'http_request':
        return this.httpRequest(args)
      case 'send_notification':
        return this.sendNotification(args)
      case 'web_search':
        return this.webSearch(args)
      case 'webpage_fetch':
        return this.webpageFetch(args)
      case 'file_edit':
        return this.fileEdit(args)
      case 'search_files':
        return this.searchFiles(args)
      case 'apply_patch':
        return this.applyPatch(args)
      case 'list_code_definition_names':
        return this.listCodeDefinitionNames(args)
      case 'ask_followup_question':
        return this.askFollowupQuestion(args)
      case 'condense':
        return this.condenseContext(args)
      case 'generate_pdf':
        return this.generatePdf(args)
      case 'generate_docx':
        return this.generateDocx(args)
      case 'generate_xlsx':
        return this.generateXlsx(args)
      case 'generate_pptx':
        return this.generatePptx(args)
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
      // Binary document extraction (PDF, DOCX, XLSX)
      if (isBinaryDocument(filePath)) {
        const content = await extractDocumentText(filePath)
        return {
          toolKey: 'local::file_read',
          success: true,
          content,
          isError: false,
          duration: Date.now() - start,
        }
      }

      const fullContent = await readFile(filePath, { encoding })
      const allLines = fullContent.split('\n')
      const totalLines = allLines.length

      // Support line-range reading for large files
      const startLine = typeof args.start_line === 'number' ? Math.max(1, Math.floor(args.start_line)) : 1
      const endLine = typeof args.end_line === 'number' ? Math.min(totalLines, Math.floor(args.end_line)) : totalLines
      const isPartial = startLine > 1 || endLine < totalLines

      let content: string
      if (isPartial) {
        const selectedLines = allLines.slice(startLine - 1, endLine)
        content = `[Lines ${startLine}-${endLine} of ${totalLines} total]\n` + selectedLines.join('\n')
      } else {
        content = fullContent
      }

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
      // Backup existing file before overwriting
      try {
        const existingContent = await readFile(filePath, 'utf-8')
        this.storeBackup(filePath, existingContent)
      } catch { /* file doesn't exist yet — no backup needed */ }

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
      // Backup file before deleting
      try {
        const existingContent = await readFile(filePath, 'utf-8')
        this.storeBackup(filePath, existingContent)
      } catch { /* couldn't read — proceed with delete anyway */ }

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

  // ─── Create Directory ────────────────────────────────

  private async createDirectory(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const dirPath = resolve(String(args.path ?? ''))
    const start = Date.now()

    // Safety gate (treat as file_write to the directory path)
    const verdict = getHardEngine().evaluate({ type: 'file_write', path: dirPath, content: '', size: 0 })
    if (!verdict.allowed) {
      return this.blocked('local::create_directory', verdict.reason, start)
    }

    try {
      await mkdir(dirPath, { recursive: true })
      return {
        toolKey: 'local::create_directory',
        success: true,
        content: `Successfully created directory ${dirPath}`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::create_directory', this.errMsg(err), start)
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
    let timeout = typeof args.timeout === 'number' ? args.timeout : 30_000
    // Auto-detect: if timeout < 1000, the model likely passed seconds instead of ms
    if (timeout > 0 && timeout < 1000) {
      timeout = timeout * 1000
    }
    const background = args.background === true
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

    // ── Background mode: spawn detached and return immediately ──
    if (background) {
      try {
        const isWin = process.platform === 'win32'
        const child = spawn(
          isWin ? 'cmd' : 'sh',
          isWin ? ['/c', command] : ['-c', command],
          {
            cwd,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          }
        )
        const pid = child.pid ?? 0
        if (pid) {
          this.backgroundProcesses.set(pid, child)
        }
        console.log(`[LocalTools] Background process started: PID=${pid} cmd="${command.slice(0, 100)}"`)

        // Capture initial stdout/stderr for crash detection
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString().slice(0, 4000) })
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString().slice(0, 4000) })

        // Wait up to 2s and check if the process crashed
        let exited = false
        let exitCode: number | null = null
        child.on('exit', (code) => { exited = true; exitCode = code })
        await new Promise(r => setTimeout(r, 2000))

        if (exited || child.exitCode !== null) {
          // Process died during startup — report the error
          this.backgroundProcesses.delete(pid)
          const code = exitCode ?? child.exitCode ?? 'unknown'
          const output = [
            `Background process exited immediately (code ${code}).`,
            stdout.trim() ? `STDOUT:\n${stdout.trim()}` : '',
            stderr.trim() ? `STDERR:\n${stderr.trim()}` : '',
            'The server failed to start. Check if the port is already in use or the command is correct.',
          ].filter(Boolean).join('\n')
          console.log(`[LocalTools] Background process crashed immediately: PID=${pid} code=${code}`)
          return this.error('local::shell_execute', output, start)
        }

        // Process is still alive — disconnect pipes and let it run freely
        const capturedInfo = (stderr.trim() || stdout.trim()).slice(0, 200)
        child.stdout?.removeAllListeners('data')
        child.stderr?.removeAllListeners('data')
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.unref()

        console.log(`[LocalTools] Background process confirmed alive: PID=${pid}${capturedInfo ? ` | ${capturedInfo}` : ''}`)

        return {
          toolKey: 'local::shell_execute',
          success: true,
          content: `Background process started and confirmed running (PID: ${pid}).${capturedInfo ? ` Server output: "${capturedInfo}"` : ''} To stop it later, call shell_kill with pid=${pid}.`,
          isError: false,
          duration: Date.now() - start,
        }
      } catch (err) {
        return this.error('local::shell_execute', `Failed to start background process: ${err instanceof Error ? err.message : String(err)}`, start)
      }
    }

    // ── Normal (foreground) mode: exec and wait ──
    return new Promise<McpToolCallResult>((resolvePromise) => {
      exec(
        command,
        {
          cwd,
          timeout,
          maxBuffer: Infinity,
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
              stdout?.trim() ? `\nSTDOUT:\n${stdout}` : '',
              stderr?.trim() ? `\nSTDERR:\n${stderr}` : '',
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
              stdout?.trim() ? stdout : '(no output)',
              stderr?.trim() ? `\nSTDERR:\n${stderr}` : '',
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

  // ─── Shell Kill ──────────────────────────────────────

  private async shellKill(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const pid = typeof args.pid === 'number' ? args.pid : parseInt(String(args.pid ?? '0'), 10)
    const start = Date.now()

    if (!pid) {
      return this.error('local::shell_kill', 'pid is required', start)
    }

    const child = this.backgroundProcesses.get(pid)
    try {
      if (process.platform === 'win32') {
        // On Windows, kill the process tree
        exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true })
      } else {
        // On Unix, kill the process group
        process.kill(-pid, 'SIGTERM')
      }
      if (child) {
        this.backgroundProcesses.delete(pid)
      }
      console.log(`[LocalTools] Background process killed: PID=${pid}`)
      return {
        toolKey: 'local::shell_kill',
        success: true,
        content: `Process ${pid} killed.`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::shell_kill', `Failed to kill process ${pid}: ${err instanceof Error ? err.message : String(err)}`, start)
    }
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

  // ─── List Code Definition Names ──────────────────────────────────────────

  private async listCodeDefinitionNames(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const targetPath = resolve(String(args.path ?? ''))
    const start = Date.now()

    const verdict = getHardEngine().evaluate({ type: 'file_read', path: targetPath })
    if (!verdict.allowed) {
      return this.blocked('local::list_code_definition_names', verdict.reason, start)
    }

    try {
      const stats = await stat(targetPath)
      const results: string[] = []

      if (stats.isFile()) {
        const defs = await this.parseCodeDefinitions(targetPath)
        if (defs.length > 0) {
          results.push(`## ${basename(targetPath)}`, ...defs.map(d => `  ${d}`))
        } else {
          results.push(`${basename(targetPath)}: No definitions found (unsupported or empty)`)
        }
      } else if (stats.isDirectory()) {
        const entries = await readdir(targetPath, { withFileTypes: true })
        const supportedExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs'])

        for (const entry of entries) {
          if (!entry.isFile()) continue
          const ext = entry.name.slice(entry.name.lastIndexOf('.'))
          if (!supportedExts.has(ext)) continue

          const filePath = join(targetPath, entry.name)
          const defs = await this.parseCodeDefinitions(filePath)
          if (defs.length > 0) {
            results.push(`## ${entry.name}`, ...defs.map(d => `  ${d}`))
          }
        }

        if (results.length === 0) {
          results.push('No code definitions found in directory')
        }
      }

      return {
        toolKey: 'local::list_code_definition_names',
        success: true,
        content: results.join('\n'),
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::list_code_definition_names', this.errMsg(err), start)
    }
  }

  /** Parse top-level definitions from a source file using regex-based extraction */
  private async parseCodeDefinitions(filePath: string): Promise<string[]> {
    try {
      const content = await readFile(filePath, 'utf-8')
      const ext = filePath.slice(filePath.lastIndexOf('.'))
      const defs: string[] = []

      switch (ext) {
        case '.ts':
        case '.tsx':
        case '.js':
        case '.jsx':
          this.extractJsTsDefinitions(content, defs)
          break
        case '.py':
          this.extractPythonDefinitions(content, defs)
          break
        case '.go':
          this.extractGoDefinitions(content, defs)
          break
        case '.rs':
          this.extractRustDefinitions(content, defs)
          break
        case '.java':
        case '.cs':
          this.extractJavaDefinitions(content, defs)
          break
        case '.c':
        case '.cpp':
        case '.h':
        case '.hpp':
          this.extractCDefinitions(content, defs)
          break
      }

      return defs
    } catch {
      return []
    }
  }

  /** Extract TypeScript/JavaScript definitions */
  private extractJsTsDefinitions(content: string, defs: string[]): void {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trimStart()

      // Skip comments and empty lines
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || !trimmed) continue

      // export/default variations
      const exportPrefix = trimmed.startsWith('export ') ? 'export ' : ''
      const afterExport = exportPrefix ? trimmed.slice(7).trimStart() : trimmed
      const defaultPrefix = afterExport.startsWith('default ') ? 'default ' : ''
      const core = defaultPrefix ? afterExport.slice(8).trimStart() : afterExport

      // Class
      let m = core.match(/^(?:abstract\s+)?class\s+(\w+)/)
      if (m) { defs.push(`${exportPrefix}${defaultPrefix}class ${m[1]} (line ${i + 1})`); continue }

      // Interface
      m = core.match(/^interface\s+(\w+)/)
      if (m) { defs.push(`${exportPrefix}interface ${m[1]} (line ${i + 1})`); continue }

      // Type alias
      m = core.match(/^type\s+(\w+)/)
      if (m) { defs.push(`${exportPrefix}type ${m[1]} (line ${i + 1})`); continue }

      // Enum
      m = core.match(/^enum\s+(\w+)/)
      if (m) { defs.push(`${exportPrefix}enum ${m[1]} (line ${i + 1})`); continue }

      // Function declaration
      m = core.match(/^(?:async\s+)?function\s+(\w+)/)
      if (m) { defs.push(`${exportPrefix}${defaultPrefix}function ${m[1]}() (line ${i + 1})`); continue }

      // Arrow/const function (top-level only — no leading indentation beyond export)
      if (line.match(/^(?:export\s+)?(?:const|let|var)\s/)) {
        m = core.match(/^(?:const|let|var)\s+(\w+)\s*(?::\s*\S+\s*)?=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/)
        if (m) { defs.push(`${exportPrefix}const ${m[1]} (arrow fn, line ${i + 1})`); continue }
        m = core.match(/^(?:const|let|var)\s+(\w+)\s*(?::\s*\S+\s*)?=\s*(?:async\s+)?function/)
        if (m) { defs.push(`${exportPrefix}const ${m[1]} (fn, line ${i + 1})`); continue }
        // Non-function const exports
        m = core.match(/^(?:const|let|var)\s+(\w+)/)
        if (m && exportPrefix) { defs.push(`${exportPrefix}const ${m[1]} (line ${i + 1})`); continue }
      }
    }
  }

  /** Extract Python definitions */
  private extractPythonDefinitions(content: string, defs: string[]): void {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Top-level only: no leading whitespace
      if (line.startsWith(' ') || line.startsWith('\t')) continue

      let m = line.match(/^class\s+(\w+)/)
      if (m) { defs.push(`class ${m[1]} (line ${i + 1})`); continue }

      m = line.match(/^(?:async\s+)?def\s+(\w+)/)
      if (m) { defs.push(`def ${m[1]}() (line ${i + 1})`); continue }

      m = line.match(/^(\w+)\s*=/)
      if (m && m[1] === m[1].toUpperCase()) { defs.push(`${m[1]} (constant, line ${i + 1})`); continue }
    }
  }

  /** Extract Go definitions */
  private extractGoDefinitions(content: string, defs: string[]): void {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimStart()

      let m = line.match(/^func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)\s*\(/)
      if (m) { defs.push(`func ${m[1]}() (line ${i + 1})`); continue }

      m = line.match(/^type\s+(\w+)\s+(struct|interface)/)
      if (m) { defs.push(`type ${m[1]} ${m[2]} (line ${i + 1})`); continue }

      m = line.match(/^var\s+(\w+)/)
      if (m) { defs.push(`var ${m[1]} (line ${i + 1})`); continue }
    }
  }

  /** Extract Rust definitions */
  private extractRustDefinitions(content: string, defs: string[]): void {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimStart()

      let m = line.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/)
      if (m) { defs.push(`fn ${m[1]}() (line ${i + 1})`); continue }

      m = line.match(/^(?:pub\s+)?struct\s+(\w+)/)
      if (m) { defs.push(`struct ${m[1]} (line ${i + 1})`); continue }

      m = line.match(/^(?:pub\s+)?enum\s+(\w+)/)
      if (m) { defs.push(`enum ${m[1]} (line ${i + 1})`); continue }

      m = line.match(/^(?:pub\s+)?trait\s+(\w+)/)
      if (m) { defs.push(`trait ${m[1]} (line ${i + 1})`); continue }

      m = line.match(/^(?:pub\s+)?type\s+(\w+)/)
      if (m) { defs.push(`type ${m[1]} (line ${i + 1})`); continue }

      m = line.match(/^impl(?:<[^>]+>)?\s+(\w+)/)
      if (m) { defs.push(`impl ${m[1]} (line ${i + 1})`); continue }
    }
  }

  /** Extract Java/C# definitions */
  private extractJavaDefinitions(content: string, defs: string[]): void {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimStart()

      let m = line.match(/^(?:public|private|protected|static|final|abstract|synchronized|\s)*class\s+(\w+)/)
      if (m) { defs.push(`class ${m[1]} (line ${i + 1})`); continue }

      m = line.match(/^(?:public|private|protected|static|final|abstract|synchronized|\s)*interface\s+(\w+)/)
      if (m) { defs.push(`interface ${m[1]} (line ${i + 1})`); continue }

      m = line.match(/^(?:public|private|protected|static|final|abstract|synchronized|\s)*enum\s+(\w+)/)
      if (m) { defs.push(`enum ${m[1]} (line ${i + 1})`); continue }
    }
  }

  /** Extract C/C++ definitions */
  private extractCDefinitions(content: string, defs: string[]): void {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith(' ') || line.startsWith('\t')) continue

      let m = line.match(/^(?:static\s+)?(?:inline\s+)?(?:const\s+)?(?:\w+\s+)+(\w+)\s*\(/)
      if (m && !['if', 'for', 'while', 'switch', 'return'].includes(m[1])) {
        defs.push(`${m[1]}() (line ${i + 1})`); continue
      }

      m = line.match(/^(?:typedef\s+)?struct\s+(\w+)/)
      if (m) { defs.push(`struct ${m[1]} (line ${i + 1})`); continue }

      m = line.match(/^typedef\s+.*\s+(\w+)\s*;/)
      if (m) { defs.push(`typedef ${m[1]} (line ${i + 1})`); continue }

      m = line.match(/^#define\s+(\w+)/)
      if (m) { defs.push(`#define ${m[1]} (line ${i + 1})`); continue }

      m = line.match(/^(?:class|namespace)\s+(\w+)/)
      if (m) { defs.push(`${line.includes('class') ? 'class' : 'namespace'} ${m[1]} (line ${i + 1})`); continue }
    }
  }

  // ─── Ask Followup Question ──────────────────────────────────────────────

  /**
   * Ask the user a clarifying question and wait for their response.
   * Emits an event to the UI, then blocks until the user responds.
   */
  private async askFollowupQuestion(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const question = String(args.question ?? '')
    const start = Date.now()

    if (!question) {
      return this.error('local::ask_followup_question', 'question is required', start)
    }

    // Parse options if provided
    let options: string[] | undefined
    if (args.options) {
      try {
        options = typeof args.options === 'string' ? JSON.parse(args.options) : args.options as string[]
      } catch { /* ignore invalid JSON */ }
    }

    const bus = getEventBus()
    const questionId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Emit question to UI
    bus.emitEvent('agent:ask-user', {
      questionId,
      question,
      options,
    })

    // Wait for user response (with timeout)
    const TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

    try {
      const response = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error('User did not respond within 5 minutes'))
        }, TIMEOUT_MS)

        const cleanup = bus.onEvent('agent:user-response', (data) => {
          if (data.questionId === questionId) {
            clearTimeout(timer)
            cleanup()
            resolve(data.response)
          }
        })
      })

      return {
        toolKey: 'local::ask_followup_question',
        success: true,
        content: `User responded: ${response}`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::ask_followup_question', this.errMsg(err), start)
    }
  }

  // ─── Condense Context ───────────────────────────────────────────────────

  /**
   * Condense the conversation history to free up context window space.
   * This is a signal tool — the actual condensation is performed by the
   * ConversationManager in base-agent.ts when it sees this tool result.
   */
  private async condenseContext(_args: Record<string, unknown>): Promise<McpToolCallResult> {
    const start = Date.now()

    // Emit event so base-agent can intercept and trigger actual condensation
    getEventBus().emitEvent('agent:condense-requested', {})

    return {
      toolKey: 'local::condense',
      success: true,
      content: 'Context condensation triggered. The conversation history will be trimmed to free up context space.',
      isError: false,
      duration: Date.now() - start,
    }
  }

  // ─── Search Files ────────────────────────────────────────────────────────

  private async searchFiles(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const dirPath = resolve(String(args.path ?? ''))
    const regexStr = String(args.regex ?? '')
    const filePattern = args.file_pattern ? String(args.file_pattern) : undefined
    const start = Date.now()

    if (!regexStr) {
      return this.error('local::search_files', 'regex pattern is required', start)
    }

    // Safety gate
    const verdict = getHardEngine().evaluate({ type: 'file_read', path: dirPath })
    if (!verdict.allowed) {
      return this.blocked('local::search_files', verdict.reason, start)
    }

    try {
      const regex = new RegExp(regexStr, 'gi')
      const results: string[] = []
      const MAX_RESULTS = 300
      const MAX_FILE_SIZE = 1024 * 1024 // 1MB

      // Build file extension filter from glob pattern
      const extFilter = filePattern ? this.globToExtensions(filePattern) : null

      await this.walkDir(dirPath, async (filePath) => {
        if (results.length >= MAX_RESULTS) return

        // Check extension filter
        if (extFilter && !extFilter(filePath)) return

        // Skip very large files
        try {
          const stats = await stat(filePath)
          if (stats.size > MAX_FILE_SIZE || stats.size === 0) return
        } catch { return }

        try {
          const content = await readFile(filePath, 'utf-8')
          // Quick binary check — null bytes → skip
          if (content.includes('\0')) return

          const lines = content.split('\n')
          for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
            regex.lastIndex = 0
            if (regex.test(lines[i])) {
              results.push(`${filePath}:${i + 1}: ${lines[i].trimEnd()}`)
            }
          }
        } catch { /* skip unreadable files */ }
      })

      if (results.length === 0) {
        return {
          toolKey: 'local::search_files',
          success: true,
          content: `No matches found for /${regexStr}/ in ${dirPath}`,
          isError: false,
          duration: Date.now() - start,
        }
      }

      const truncNote = results.length >= MAX_RESULTS ? `\n\n(Results truncated at ${MAX_RESULTS} matches)` : ''
      return {
        toolKey: 'local::search_files',
        success: true,
        content: `Found ${results.length} match(es) for /${regexStr}/:\n\n${results.join('\n')}${truncNote}`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::search_files', this.errMsg(err), start)
    }
  }

  /** Recursively walk a directory, calling fn for each file */
  private async walkDir(dir: string, fn: (filePath: string) => Promise<void>): Promise<void> {
    const SKIP_DIRS = new Set([
      'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
      '.venv', 'coverage', '.cache', '.turbo', 'out',
    ])

    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            await this.walkDir(fullPath, fn)
          }
        } else if (entry.isFile()) {
          await fn(fullPath)
        }
      }
    } catch { /* skip inaccessible directories */ }
  }

  /** Convert a simple glob pattern (e.g. "*.ts", "*.{js,tsx}") to a file filter function */
  private globToExtensions(pattern: string): ((filePath: string) => boolean) | null {
    // Handle patterns like "*.ts", "*.{js,tsx,ts}", "*.js"
    const match = pattern.match(/^\*\.(?:\{([^}]+)\}|(\w+))$/)
    if (match) {
      const exts = (match[1] ?? match[2]).split(',').map(e => `.${e.trim()}`)
      return (filePath: string) => exts.some(ext => filePath.endsWith(ext))
    }
    // Fallback: treat as a simple extension
    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1)
      return (filePath: string) => filePath.endsWith(ext)
    }
    return null // Can't parse — match all files
  }

  // ─── File Edit (search-and-replace with fuzzy matching) ──────────────────

  private async fileEdit(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const filePath = resolve(String(args.path ?? ''))
    const start = Date.now()

    // ── Multi-block diff mode (diff_blocks param) ──
    if (args.diff_blocks) {
      return this.fileEditMultiBlock(filePath, args.diff_blocks, start)
    }

    // ── Single edit mode (old_string → new_string) ──
    const oldString = String(args.old_string ?? '')
    const newString = String(args.new_string ?? '')

    if (!oldString) {
      return this.error('local::file_edit', 'old_string is required and cannot be empty', start)
    }

    // Safety gate — needs both read and write access
    const readVerdict = getHardEngine().evaluate({ type: 'file_read', path: filePath })
    if (!readVerdict.allowed) {
      return this.blocked('local::file_edit', readVerdict.reason, start)
    }
    const writeVerdict = getHardEngine().evaluate({
      type: 'file_write', path: filePath, content: newString, size: Buffer.byteLength(newString, 'utf-8'),
    })
    if (!writeVerdict.allowed) {
      return this.blocked('local::file_edit', writeVerdict.reason, start)
    }

    try {
      const content = await readFile(filePath, 'utf-8')

      // ── Tier 1: Exact match (fastest, most reliable) ──
      const exactOccurrences = content.split(oldString).length - 1

      if (exactOccurrences === 1) {
        return this.applyEdit(filePath, content, oldString, newString, start, 'exact')
      }

      if (exactOccurrences > 1) {
        return this.error(
          'local::file_edit',
          `old_string matches ${exactOccurrences} locations in ${filePath}. Include more surrounding context to make the match unique.`,
          start
        )
      }

      // ── Tier 2: Whitespace-flexible match ──
      // Normalize whitespace: collapse runs of spaces/tabs, trim line endings
      const normalizeWS = (s: string) =>
        s.split('\n').map(line => line.replace(/[\t ]+/g, ' ').trimEnd()).join('\n')

      const normalizedContent = normalizeWS(content)
      const normalizedOld = normalizeWS(oldString)
      const wsOccurrences = normalizedContent.split(normalizedOld).length - 1

      if (wsOccurrences === 1) {
        // Find the actual location in the original content by matching normalized positions
        const wsIndex = normalizedContent.indexOf(normalizedOld)
        // Map back to original content by matching line-by-line
        const matchResult = this.findWhitespaceFlexibleMatch(content, oldString)
        if (matchResult) {
          console.log(`[file_edit] Tier 2 (whitespace-flexible) match for ${filePath}`)
          return this.applyEdit(filePath, content, matchResult, newString, start, 'whitespace-flexible')
        }
      }

      // ── Tier 3: Line-trimmed match ──
      // Trim each line of both sides, then match
      const trimLines = (s: string) =>
        s.split('\n').map(line => line.trim()).join('\n')

      const trimmedContent = trimLines(content)
      const trimmedOld = trimLines(oldString)
      const trimOccurrences = trimmedContent.split(trimmedOld).length - 1

      if (trimOccurrences === 1) {
        const matchResult = this.findLineTrimmedMatch(content, oldString)
        if (matchResult) {
          console.log(`[file_edit] Tier 3 (line-trimmed) match for ${filePath}`)
          return this.applyEdit(filePath, content, matchResult, newString, start, 'line-trimmed')
        }
      }

      // ── Tier 4: Fuzzy similarity match ──
      // Find the most similar block in the file using line-based comparison
      const fuzzyResult = this.findFuzzyMatch(content, oldString, 0.75)
      if (fuzzyResult) {
        console.log(`[file_edit] Tier 4 (fuzzy, ${(fuzzyResult.similarity * 100).toFixed(0)}% match) for ${filePath}`)
        return this.applyEdit(filePath, content, fuzzyResult.matched, newString, start, `fuzzy-${(fuzzyResult.similarity * 100).toFixed(0)}%`)
      }

      // All tiers failed — provide helpful error
      const contentLines = content.split('\n')
      const oldLines = oldString.split('\n')
      return this.error(
        'local::file_edit',
        `old_string not found in ${filePath} (tried exact, whitespace-flexible, line-trimmed, and fuzzy matching). ` +
        `File has ${contentLines.length} lines, old_string has ${oldLines.length} lines. ` +
        `First 3 lines of file: "${contentLines.slice(0, 3).join('\\n')}"`,
        start
      )
    } catch (err) {
      return this.error('local::file_edit', this.errMsg(err), start)
    }
  }

  /** Apply a verified edit and write the result */
  private async applyEdit(
    filePath: string,
    content: string,
    matchedOld: string,
    newString: string,
    start: number,
    matchTier: string
  ): Promise<McpToolCallResult> {
    // Create backup before writing
    this.storeBackup(filePath, content)

    const newContent = content.replace(matchedOld, newString)
    await writeFile(filePath, newContent, 'utf-8')

    const oldLines = matchedOld.split('\n').length
    const newLines = newString.split('\n').length
    const diffSummary = oldLines === newLines
      ? `${oldLines} line(s) modified`
      : `${oldLines} line(s) → ${newLines} line(s)`

    // Show a preview of the changed region so the model can verify its edit immediately
    const previewLines = newString.split('\n')
    const maxPreview = 15
    const preview = previewLines.slice(0, maxPreview).join('\n')
    const truncNote = previewLines.length > maxPreview ? `\n... (${previewLines.length - maxPreview} more lines)` : ''

    return {
      toolKey: 'local::file_edit',
      success: true,
      content: `File edited successfully: ${filePath} (${diffSummary}, match=${matchTier}, ${Buffer.byteLength(newContent)} bytes total)\n\nChanged region now reads:\n${preview}${truncNote}`,
      isError: false,
      duration: Date.now() - start,
    }
  }

  /**
   * Find a whitespace-flexible match in the content.
   * Returns the actual substring from content that matches when whitespace is normalized.
   */
  private findWhitespaceFlexibleMatch(content: string, oldString: string): string | null {
    const contentLines = content.split('\n')
    const oldLines = oldString.split('\n')
    const normalizeLine = (line: string) => line.replace(/[\t ]+/g, ' ').trimEnd()

    const normalizedOldLines = oldLines.map(normalizeLine)

    // Slide a window of oldLines.length over contentLines
    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      let matches = true
      for (let j = 0; j < oldLines.length; j++) {
        if (normalizeLine(contentLines[i + j]) !== normalizedOldLines[j]) {
          matches = false
          break
        }
      }
      if (matches) {
        // Return the original lines from content (preserving original whitespace)
        return contentLines.slice(i, i + oldLines.length).join('\n')
      }
    }
    return null
  }

  /**
   * Find a line-trimmed match in the content.
   * Returns the actual substring that matches when lines are trimmed.
   */
  private findLineTrimmedMatch(content: string, oldString: string): string | null {
    const contentLines = content.split('\n')
    const oldLines = oldString.split('\n')
    const trimmedOldLines = oldLines.map(l => l.trim())

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      let matches = true
      for (let j = 0; j < oldLines.length; j++) {
        if (contentLines[i + j].trim() !== trimmedOldLines[j]) {
          matches = false
          break
        }
      }
      if (matches) {
        return contentLines.slice(i, i + oldLines.length).join('\n')
      }
    }
    return null
  }

  /**
   * Find the best fuzzy match for old_string in the content.
   * Uses line-based Levenshtein similarity. Returns null if no match
   * exceeds the minimum similarity threshold.
   *
   * Inspired by Aider's SequenceMatcher approach.
   */
  private findFuzzyMatch(
    content: string,
    oldString: string,
    minSimilarity: number
  ): { matched: string; similarity: number } | null {
    const contentLines = content.split('\n')
    const oldLines = oldString.split('\n')

    if (oldLines.length > contentLines.length) return null

    let bestMatch: { start: number; end: number; similarity: number } | null = null

    // Slide a window of oldLines.length ± 2 over contentLines
    for (let windowSize = Math.max(1, oldLines.length - 2); windowSize <= Math.min(contentLines.length, oldLines.length + 2); windowSize++) {
      for (let i = 0; i <= contentLines.length - windowSize; i++) {
        const candidateLines = contentLines.slice(i, i + windowSize)
        const similarity = this.calculateLineSimilarity(candidateLines, oldLines)

        if (similarity >= minSimilarity && (!bestMatch || similarity > bestMatch.similarity)) {
          bestMatch = { start: i, end: i + windowSize, similarity }
        }
      }
    }

    if (!bestMatch) return null

    // Verify uniqueness — check if there's another match with similar similarity
    let secondBest = 0
    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      if (i === bestMatch.start) continue
      const candidateLines = contentLines.slice(i, i + oldLines.length)
      const sim = this.calculateLineSimilarity(candidateLines, oldLines)
      if (sim > secondBest) secondBest = sim
    }

    // If the second-best match is too close, the match is ambiguous
    if (secondBest > 0.9 * bestMatch.similarity && secondBest >= minSimilarity) {
      return null // ambiguous — multiple similar blocks
    }

    return {
      matched: contentLines.slice(bestMatch.start, bestMatch.end).join('\n'),
      similarity: bestMatch.similarity,
    }
  }

  /**
   * Calculate similarity between two arrays of lines (0.0 to 1.0).
   * Uses a simple ratio of matching lines + character-level similarity for close lines.
   */
  private calculateLineSimilarity(a: string[], b: string[]): number {
    const maxLen = Math.max(a.length, b.length)
    if (maxLen === 0) return 1.0

    let totalSimilarity = 0
    const minLen = Math.min(a.length, b.length)

    for (let i = 0; i < minLen; i++) {
      if (a[i] === b[i]) {
        totalSimilarity += 1.0
      } else if (a[i].trim() === b[i].trim()) {
        totalSimilarity += 0.95 // whitespace-only difference
      } else {
        // Character-level similarity (simple ratio)
        totalSimilarity += this.stringSimilarity(a[i], b[i])
      }
    }

    // Penalty for length mismatch
    return totalSimilarity / maxLen
  }

  /**
   * Calculate character-level similarity between two strings (0.0 to 1.0).
   * Simple longest common subsequence ratio.
   */
  private stringSimilarity(a: string, b: string): number {
    if (a === b) return 1.0
    if (!a || !b) return 0.0

    const maxLen = Math.max(a.length, b.length)
    if (maxLen === 0) return 1.0

    // Simple approach: count matching characters at each position
    const minLen = Math.min(a.length, b.length)
    let matches = 0
    for (let i = 0; i < minLen; i++) {
      if (a[i] === b[i]) matches++
    }

    return matches / maxLen
  }

  // ─── Multi-Block File Edit (Diff Strategy) ──────────────────────────────

  /**
   * Apply multiple SEARCH/REPLACE diff blocks to a file using the diff strategy engine.
   * This is the advanced path used when diff_blocks is provided as a JSON array.
   */
  private async fileEditMultiBlock(
    filePath: string,
    rawBlocks: unknown,
    start: number
  ): Promise<McpToolCallResult> {
    // Safety gate — needs both read and write access
    const readVerdict = getHardEngine().evaluate({ type: 'file_read', path: filePath })
    if (!readVerdict.allowed) {
      return this.blocked('local::file_edit', readVerdict.reason, start)
    }

    try {
      // Parse diff_blocks: expect JSON string or already-parsed array
      let parsedBlocks: Array<{ search: string; replace: string; start_line?: number }>
      if (typeof rawBlocks === 'string') {
        parsedBlocks = JSON.parse(rawBlocks)
      } else if (Array.isArray(rawBlocks)) {
        parsedBlocks = rawBlocks
      } else {
        return this.error('local::file_edit', 'diff_blocks must be a JSON array of {search, replace} objects', start)
      }

      if (!Array.isArray(parsedBlocks) || parsedBlocks.length === 0) {
        return this.error('local::file_edit', 'diff_blocks array is empty', start)
      }

      // Map to DiffBlock[] for the strategy engine
      const blocks: DiffBlock[] = parsedBlocks.map(b => ({
        searchContent: b.search,
        replaceContent: b.replace,
        startLineHint: b.start_line,
      }))

      const content = await readFile(filePath, 'utf-8')
      this.storeBackup(filePath, content)

      const result = getDiffStrategy().applyDiff(content, blocks)

      if (!result.success) {
        // On failure, include file snippet to help the model recover
        const contentLines = content.split('\n')
        const snippet = contentLines.slice(0, 40).join('\n')
        const truncNote = contentLines.length > 40 ? `\n... (${contentLines.length - 40} more lines)` : ''
        return this.error(
          'local::file_edit',
          `${result.error}\n\nFile has ${contentLines.length} lines. First 40 lines:\n${snippet}${truncNote}`,
          start
        )
      }

      const writeVerdict = getHardEngine().evaluate({
        type: 'file_write',
        path: filePath,
        content: result.newContent,
        size: Buffer.byteLength(result.newContent),
      })
      if (!writeVerdict.allowed) {
        return this.blocked('local::file_edit', writeVerdict.reason, start)
      }

      await writeFile(filePath, result.newContent, 'utf-8')

      // Build summary from match details
      const tierSummary = result.matchDetails
        .map(d => `  Block ${d.blockIndex + 1}: ${d.matchTier}${d.similarity ? ` (${(d.similarity * 100).toFixed(0)}%)` : ''}`)
        .join('\n')

      return {
        toolKey: 'local::file_edit',
        success: true,
        content: `File edited successfully: ${filePath} (${result.appliedCount}/${result.totalBlocks} blocks applied, ${Buffer.byteLength(result.newContent)} bytes total)\n\nMatch details:\n${tierSummary}`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::file_edit', this.errMsg(err), start)
    }
  }

  // ─── Apply Patch (unified-diff multi-file edits) ─────────────────────────

  private async applyPatch(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const diffText = String(args.diff ?? '')
    const start = Date.now()

    if (!diffText.trim()) {
      return this.error('local::apply_patch', 'diff content is required', start)
    }

    try {
      const operations = parsePatchOperations(diffText)

      if (operations.length === 0) {
        return this.error('local::apply_patch', 'Could not parse any patch operations from the diff', start)
      }

      const results: string[] = []
      let errors = 0

      for (const op of operations) {
        const filePath = resolve(op.path)

        if (op.type === 'delete') {
          const verdict = getHardEngine().evaluate({ type: 'file_write', path: filePath, content: '', size: 0 })
          if (!verdict.allowed) {
            results.push(`BLOCKED: ${op.path} — ${verdict.reason}`)
            errors++
            continue
          }
          try {
            await unlink(filePath)
            results.push(`Deleted: ${op.path}`)
          } catch (err) {
            results.push(`Error deleting ${op.path}: ${this.errMsg(err)}`)
            errors++
          }
          continue
        }

        if (op.type === 'add') {
          const content = op.content ?? ''
          const verdict = getHardEngine().evaluate({
            type: 'file_write', path: filePath, content, size: Buffer.byteLength(content),
          })
          if (!verdict.allowed) {
            results.push(`BLOCKED: ${op.path} — ${verdict.reason}`)
            errors++
            continue
          }
          try {
            await mkdir(dirname(filePath), { recursive: true })
            await writeFile(filePath, content, 'utf-8')
            results.push(`Created: ${op.path} (${Buffer.byteLength(content)} bytes)`)
          } catch (err) {
            results.push(`Error creating ${op.path}: ${this.errMsg(err)}`)
            errors++
          }
          continue
        }

        // type === 'update'
        const readVerdict = getHardEngine().evaluate({ type: 'file_read', path: filePath })
        if (!readVerdict.allowed) {
          results.push(`BLOCKED: ${op.path} — ${readVerdict.reason}`)
          errors++
          continue
        }

        try {
          const fileContent = await readFile(filePath, 'utf-8')
          this.storeBackup(filePath, fileContent)

          // Convert hunks to DiffBlocks for the diff strategy
          const blocks: DiffBlock[] = (op.hunks ?? []).map(hunk => ({
            searchContent: hunk.contextLines.join('\n'),
            replaceContent: hunk.replacementLines.join('\n'),
          }))

          const result = getDiffStrategy().applyDiff(fileContent, blocks)
          if (!result.success) {
            results.push(`Failed: ${op.path} — ${result.error}`)
            errors++
            continue
          }

          const writeVerdict = getHardEngine().evaluate({
            type: 'file_write', path: filePath, content: result.newContent, size: Buffer.byteLength(result.newContent),
          })
          if (!writeVerdict.allowed) {
            results.push(`BLOCKED: ${op.path} write — ${writeVerdict.reason}`)
            errors++
            continue
          }

          await writeFile(filePath, result.newContent, 'utf-8')
          results.push(`Updated: ${op.path} (${blocks.length} hunk(s) applied)`)
        } catch (err) {
          results.push(`Error updating ${op.path}: ${this.errMsg(err)}`)
          errors++
        }
      }

      const summary = errors > 0
        ? `Patch applied with ${errors} error(s):\n\n${results.join('\n')}`
        : `Patch applied successfully:\n\n${results.join('\n')}`

      return {
        toolKey: 'local::apply_patch',
        success: errors === 0,
        content: summary,
        isError: errors > 0,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::apply_patch', this.errMsg(err), start)
    }
  }

  // ─── File Backup System ──────────────────────────────

  /** In-memory backup of file contents before modification */
  private fileBackups = new Map<string, { content: string; timestamp: number }>()
  private readonly MAX_BACKUPS = 30
  private readonly BACKUP_TTL_MS = 30 * 60 * 1000 // 30 minutes

  /** Store a backup of a file before modifying it */
  private storeBackup(filePath: string, content: string): void {
    // Evict expired backups
    const now = Date.now()
    for (const [path, backup] of this.fileBackups) {
      if (now - backup.timestamp > this.BACKUP_TTL_MS) {
        this.fileBackups.delete(path)
      }
    }

    // Evict oldest if at capacity
    if (this.fileBackups.size >= this.MAX_BACKUPS) {
      let oldestPath = ''
      let oldestTime = Infinity
      for (const [path, backup] of this.fileBackups) {
        if (backup.timestamp < oldestTime) {
          oldestTime = backup.timestamp
          oldestPath = path
        }
      }
      if (oldestPath) this.fileBackups.delete(oldestPath)
    }

    this.fileBackups.set(filePath, { content, timestamp: now })
  }

  /** Get a backup for a file (if available) */
  getBackup(filePath: string): { content: string; timestamp: number } | undefined {
    const backup = this.fileBackups.get(resolve(filePath))
    if (backup && Date.now() - backup.timestamp <= this.BACKUP_TTL_MS) {
      return backup
    }
    return undefined
  }

  // ─── Document Generation ──────────────────────────────

  private async generatePdf(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const outputPath = resolve(String(args.output_path ?? ''))
    const start = Date.now()

    const verdict = getHardEngine().evaluate({ type: 'file_write', path: outputPath })
    if (!verdict.allowed) return this.blocked('local::generate_pdf', verdict.reason, start)

    try {
      const sections = args.sections ? JSON.parse(String(args.sections)) : undefined
      const tables = args.tables ? JSON.parse(String(args.tables)) : undefined
      const result = await generatePDF(outputPath, {
        title: args.title ? String(args.title) : undefined,
        author: args.author ? String(args.author) : undefined,
        sections,
        tables,
      })
      return {
        toolKey: 'local::generate_pdf',
        success: true,
        content: `PDF generated: ${result.path} (${result.pageCount} page${result.pageCount !== 1 ? 's' : ''})`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::generate_pdf', this.errMsg(err), start)
    }
  }

  private async generateDocx(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const outputPath = resolve(String(args.output_path ?? ''))
    const start = Date.now()

    const verdict = getHardEngine().evaluate({ type: 'file_write', path: outputPath })
    if (!verdict.allowed) return this.blocked('local::generate_docx', verdict.reason, start)

    try {
      const sections = args.sections ? JSON.parse(String(args.sections)) : undefined
      const tables = args.tables ? JSON.parse(String(args.tables)) : undefined
      const result = await generateDOCX(outputPath, {
        title: args.title ? String(args.title) : undefined,
        author: args.author ? String(args.author) : undefined,
        sections,
        tables,
      })
      return {
        toolKey: 'local::generate_docx',
        success: true,
        content: `DOCX generated: ${result.path}`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::generate_docx', this.errMsg(err), start)
    }
  }

  private async generateXlsx(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const outputPath = resolve(String(args.output_path ?? ''))
    const start = Date.now()

    const verdict = getHardEngine().evaluate({ type: 'file_write', path: outputPath })
    if (!verdict.allowed) return this.blocked('local::generate_xlsx', verdict.reason, start)

    try {
      const sheets = JSON.parse(String(args.sheets ?? '[]'))
      const result = await generateXLSX(outputPath, {
        sheets,
        author: args.author ? String(args.author) : undefined,
      })
      return {
        toolKey: 'local::generate_xlsx',
        success: true,
        content: `XLSX generated: ${result.path} (${result.sheetCount} sheet${result.sheetCount !== 1 ? 's' : ''})`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::generate_xlsx', this.errMsg(err), start)
    }
  }

  private async generatePptx(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const outputPath = resolve(String(args.output_path ?? ''))
    const start = Date.now()

    const verdict = getHardEngine().evaluate({ type: 'file_write', path: outputPath })
    if (!verdict.allowed) return this.blocked('local::generate_pptx', verdict.reason, start)

    try {
      const slides = JSON.parse(String(args.slides ?? '[]'))
      const result = await generatePPTX(outputPath, {
        slides,
        title: args.title ? String(args.title) : undefined,
        author: args.author ? String(args.author) : undefined,
        subject: args.subject ? String(args.subject) : undefined,
      })
      return {
        toolKey: 'local::generate_pptx',
        success: true,
        content: `PPTX generated: ${result.path} (${result.slideCount} slide${result.slideCount !== 1 ? 's' : ''})`,
        isError: false,
        duration: Date.now() - start,
      }
    } catch (err) {
      return this.error('local::generate_pptx', this.errMsg(err), start)
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
}

// ─── Singleton ──────────────────────────────────────────────

let instance: LocalToolProvider | null = null

export function getLocalToolProvider(): LocalToolProvider {
  if (!instance) {
    instance = new LocalToolProvider()
  }
  return instance
}
