/**
 * Prose-to-Tool Extractor
 *
 * Adaptive fallback for models that don't produce XML tool blocks.
 * When a model outputs code in markdown fences or describes file operations
 * in prose, this module extracts synthetic tool calls so the agent loop
 * can execute them as if the model had used the XML protocol.
 *
 * Patterns detected:
 * 1. Markdown code blocks with file paths → file_write / file_create
 * 2. Shell/terminal commands → shell_execute
 * 3. Completion signals in prose → attempt_completion
 *
 * This is intentionally conservative — it only fires when the XML parser
 * found nothing, and only extracts high-confidence patterns.
 */

// ─── Types ──────────────────────────────────────────────────

export interface SyntheticToolCall {
  tool: string                        // e.g. 'local::file_write'
  args: Record<string, unknown>
  confidence: number                  // 0–1, how sure we are this is what the model meant
  source: 'markdown-file' | 'shell-command' | 'completion-signal'
}

export interface ExtractionResult {
  toolCalls: SyntheticToolCall[]
  completionResult: string | null     // If the prose looks like a done signal
  remainingText: string               // Prose that wasn't part of any extraction
}

// ─── File Path Detection ────────────────────────────────────

/**
 * Regex patterns to detect file paths near code blocks.
 * Models commonly write patterns like:
 *   - "Here's `src/app/page.tsx`:" followed by a code block
 *   - "// filepath: src/config.ts" inside a code block
 *   - "Create file at `D:\project\file.ts`" before a code block
 *   - "**`tailwind.config.ts`**" before a code block
 *   - "### 1. `components/Navbar.tsx`" before a code block
 */
const FILE_PATH_PATTERNS = [
  // "// filepath: ..." or "// file: ..." at beginning of code block content
  /^\/\/\s*(?:file(?:path)?|name)\s*:\s*(.+?)$/m,
  // "# filepath: ..." (Python-style comment)
  /^#\s*(?:file(?:path)?|name)\s*:\s*(.+?)$/m,
  // "/* filepath: ... */"
  /^\/\*\s*(?:file(?:path)?|name)\s*:\s*(.+?)\s*\*\/$/m,
]

/**
 * Patterns to find file paths in prose BEFORE a code block.
 * We look at the 1-3 lines immediately preceding the ``` fence.
 */
const PROSE_PATH_PATTERNS = [
  // **`path/to/file.tsx`** or `path/to/file.tsx`:
  /[`*]+([^\s`*]+\.[a-z]{1,5})[`*]+\s*[:.]?\s*$/i,
  // "Create/Write/Save/Update file at/to path/to/file"
  /(?:create|write|save|update|overwrite|put)\s+(?:(?:the\s+)?file\s+)?(?:at|to|in)\s+[`"']?([^\s`"']+\.[a-z]{1,5})[`"']?\s*[:.]?\s*$/i,
  // "Here's path/to/file.tsx:" or "Here is the file path/to/file:"
  /(?:here(?:'s| is))\s+(?:the\s+)?(?:file\s+)?[`"']?([^\s`"']+\.[a-z]{1,5})[`"']?\s*[:.]?\s*$/i,
  // Just a path on its own line: path/to/file.ext or D:\path\file.ext
  /^[`"']?([A-Za-z]:[\\\/][^\s`"']+\.[a-z]{1,5})[`"']?\s*[:.]?\s*$/i,
  /^[`"']?([a-zA-Z_.\-\/][^\s`"']*\.[a-z]{1,5})[`"']?\s*[:.]?\s*$/i,
  // "### N. `filename`" or "**filename**"
  /^#+\s*\d*\.?\s*[`*]+([^\s`*]+\.[a-z]{1,5})[`*]+/i,
  // "Created `file` at `path`:" or "wrote `path`:"
  /(?:created?|wrote|saved|updated|generated)\s+(?:file\s+)?(?:at\s+)?[`"']([^\s`"']+\.[a-z]{1,5})[`"']/i,
]

// Known file extensions that suggest code content
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'cs',
  'html', 'htm', 'css', 'scss', 'less', 'sass',
  'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf',
  'md', 'mdx', 'txt', 'env', 'gitignore', 'dockerignore',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'prisma',
  'vue', 'svelte', 'astro',
  'tf', 'hcl',
  'Dockerfile', 'Makefile',
])

// Language hints that map to likely extensions
const LANG_TO_EXT: Record<string, string> = {
  typescript: 'ts', tsx: 'tsx', javascript: 'js', jsx: 'jsx',
  python: 'py', ruby: 'rb', rust: 'rs', golang: 'go', go: 'go',
  java: 'java', kotlin: 'kt', swift: 'swift', csharp: 'cs',
  html: 'html', css: 'css', scss: 'scss', less: 'less',
  json: 'json', yaml: 'yml', toml: 'toml', xml: 'xml',
  sql: 'sql', graphql: 'graphql', prisma: 'prisma',
  bash: 'sh', shell: 'sh', sh: 'sh', zsh: 'sh', powershell: 'ps1',
  dockerfile: 'Dockerfile', docker: 'Dockerfile',
  makefile: 'Makefile', nginx: 'conf',
  vue: 'vue', svelte: 'svelte',
}

// ─── Shell Command Detection ───────────────────────────────

/**
 * Shell-like languages in code fences
 */
const SHELL_LANGUAGES = new Set([
  'bash', 'sh', 'shell', 'zsh', 'terminal', 'console', 'cmd', 'powershell', 'ps1',
])

/**
 * Common shell command prefixes that indicate executable commands
 * (vs configuration files)
 */
const SHELL_COMMAND_PREFIXES = [
  /^(?:\$|>|#)\s+/,              // $ command, > command, # command
  /^(?:npm|npx|yarn|pnpm)\s+/,   // Package manager commands
  /^(?:pip|pip3|python|python3)\s+/,
  /^(?:cd|mkdir|rm|cp|mv|ls|cat|echo|touch|chmod|chown|curl|wget)\s+/,
  /^(?:git|docker|docker-compose|kubectl)\s+/,
  /^(?:node|deno|bun)\s+/,
  /^(?:cargo|go|rustc|gcc|make|cmake)\s+/,
  /^(?:flutter|dart|pod)\s+/,
  /^(?:firebase|gcloud|aws|az)\s+/,
  /^(?:sudo|apt|apt-get|brew|choco|winget)\s+/,
]

// ─── Completion Detection ───────────────────────────────────

/**
 * Patterns that signal the model thinks the task is done.
 * Only used when there's strong evidence (multiple indicators).
 */
const COMPLETION_PATTERNS = [
  /^(?:successfully|done|completed|finished|all\s+(?:files?|tasks?|steps?)\s+(?:have\s+been\s+)?(?:created|completed|done|set\s*up))/i,
  /(?:the\s+(?:implementation|setup|configuration|project)\s+is\s+(?:now\s+)?(?:complete|done|ready|finished))/i,
  /^##?\s*(?:summary|result|completed?|done|output)/im,
]

// ─── Main Extractor ─────────────────────────────────────────

/**
 * Extract synthetic tool calls from model prose.
 *
 * Call this ONLY when the XML parser and JSON fallback both found nothing.
 * It scans the full response for markdown code blocks with file paths
 * and shell commands.
 */
export function extractToolsFromProse(content: string): ExtractionResult {
  const toolCalls: SyntheticToolCall[] = []
  let completionResult: string | null = null
  let remainingText = content

  // ── 1. Extract file-write calls from markdown code blocks ──
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g
  let match: RegExpExecArray | null

  // We need to work backwards through matches to track positions correctly,
  // but first we collect them all.
  const blocks: Array<{
    fullMatch: string
    lang: string
    code: string
    startIndex: number
    endIndex: number
  }> = []

  while ((match = codeBlockRegex.exec(content)) !== null) {
    blocks.push({
      fullMatch: match[0],
      lang: match[1]?.toLowerCase() ?? '',
      code: match[2],
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    })
  }

  for (const block of blocks) {
    // ── Shell commands ──
    if (SHELL_LANGUAGES.has(block.lang) || isShellCommand(block.code)) {
      const commands = extractShellCommands(block.code)
      for (const cmd of commands) {
        toolCalls.push({
          tool: 'local::shell_execute',
          args: { command: cmd },
          confidence: 0.8,
          source: 'shell-command',
        })
      }
      continue
    }

    // ── File content blocks ──
    const filePath = detectFilePath(block, content)
    if (filePath) {
      // Determine if this is a new file or overwrite
      const codeContent = stripFilePathComment(block.code)
      toolCalls.push({
        tool: 'local::file_write',
        args: {
          path: filePath,
          content: codeContent,
        },
        confidence: filePath.includes('/') || filePath.includes('\\') ? 0.9 : 0.7,
        source: 'markdown-file',
      })
    }
  }

  // ── 2. Check for completion signals ──
  if (toolCalls.length > 0) {
    // If we extracted tool calls, also check if the prose around them
    // indicates the model considers the task complete
    const proseWithoutCodeBlocks = content.replace(/```[\s\S]*?```/g, '').trim()
    const hasCompletionSignal = COMPLETION_PATTERNS.some(p => p.test(proseWithoutCodeBlocks))
    
    if (hasCompletionSignal) {
      // Extract a summary from the prose
      const summaryLines = proseWithoutCodeBlocks
        .split('\n')
        .filter(l => l.trim().length > 0)
        .slice(0, 10)
        .join('\n')
      completionResult = summaryLines || 'Task completed (extracted from prose)'
    }
  } else if (blocks.length === 0) {
    // No code blocks at all — check if it's a pure completion/answer
    const hasCompletion = COMPLETION_PATTERNS.some(p => p.test(content))
    if (hasCompletion && content.length > 20) {
      completionResult = content.trim()
    }
  }

  // Build remaining text (everything that wasn't consumed by extractions)
  remainingText = content.replace(/```[\s\S]*?```/g, '').trim()

  return { toolCalls, completionResult, remainingText }
}

// ─── Helpers ────────────────────────────────────────────────

/** Check if code content looks like shell commands (without language hint) */
function isShellCommand(code: string): boolean {
  const firstLine = code.trim().split('\n')[0].trim()
  return SHELL_COMMAND_PREFIXES.some(p => p.test(firstLine))
}

/** Extract individual commands from a shell code block */
function extractShellCommands(code: string): string[] {
  const commands: string[] = []
  const lines = code.trim().split('\n')

  let current = ''
  for (const line of lines) {
    // Strip leading $ or > prompt markers
    const cleaned = line.replace(/^\s*[$>]\s+/, '').trim()
    if (!cleaned || cleaned.startsWith('#')) continue

    // Handle line continuations
    if (cleaned.endsWith('\\')) {
      current += cleaned.slice(0, -1).trim() + ' '
      continue
    }

    current += cleaned
    if (current) {
      commands.push(current)
      current = ''
    }
  }
  if (current) commands.push(current)

  return commands
}

/** Try to detect a file path for a code block */
function detectFilePath(
  block: { lang: string; code: string; startIndex: number },
  fullContent: string
): string | null {
  // ── Strategy 1: File path comment inside the code block ──
  for (const pattern of FILE_PATH_PATTERNS) {
    const m = block.code.match(pattern)
    if (m) {
      const path = cleanFilePath(m[1])
      if (path && looksLikeFilePath(path)) return path
    }
  }

  // ── Strategy 2: Prose before the code block ──
  // Look at the 1-5 lines immediately before the ``` fence
  const textBefore = fullContent.slice(0, block.startIndex)
  const linesBefore = textBefore.split('\n').filter(l => l.trim()).slice(-5)

  for (const line of linesBefore.reverse()) {
    for (const pattern of PROSE_PATH_PATTERNS) {
      const m = line.match(pattern)
      if (m) {
        const path = cleanFilePath(m[1])
        if (path && looksLikeFilePath(path)) return path
      }
    }
  }

  // ── Strategy 3: Language hint + context ──
  // If we have a language hint and the code is substantial, try to infer
  // from the code content itself (e.g. "export default function App" → App.tsx)
  // This is too speculative — skip for now to avoid false positives.

  return null
}

/** Clean up a raw file path string */
function cleanFilePath(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')    // Strip quotes
    .replace(/^\.\//, '')                 // Strip leading ./
    .replace(/\*\*/g, '')                 // Strip markdown bold
    .replace(/[:;,]$/, '')                // Strip trailing punctuation
    .trim()
}

/** Minimal check: does this string look like a file path? */
function looksLikeFilePath(p: string): boolean {
  if (!p || p.length < 3 || p.length > 300) return false
  // Must contain a dot (for extension) OR be a known extensionless file
  const extensionless = ['Dockerfile', 'Makefile', 'Gemfile', 'Rakefile', 'Procfile', '.env', '.gitignore', '.dockerignore']
  if (extensionless.some(e => p.endsWith(e))) return true
  const ext = p.split('.').pop()?.toLowerCase()
  if (!ext) return false
  return CODE_EXTENSIONS.has(ext)
}

/** Strip file-path comments from the top of code content */
function stripFilePathComment(code: string): string {
  const lines = code.split('\n')
  // Remove first line if it's just a filepath comment
  if (lines.length > 0) {
    const first = lines[0].trim()
    const isPathComment = FILE_PATH_PATTERNS.some(p => p.test(first))
    if (isPathComment) {
      return lines.slice(1).join('\n')
    }
  }
  return code
}
