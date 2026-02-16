import { useEffect, useRef, useState } from 'react'
import { FileCode2, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react'
import { Markdown } from '../../components/Markdown'

/**
 * Detects file extension from a path string for language labelling.
 */
function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX',
    html: 'HTML', css: 'CSS', json: 'JSON', md: 'Markdown',
    py: 'Python', rs: 'Rust', go: 'Go', sql: 'SQL',
    yaml: 'YAML', yml: 'YAML', toml: 'TOML', sh: 'Shell',
    bash: 'Shell', xml: 'XML', svg: 'SVG', txt: 'Text',
  }
  return map[ext] ?? (ext.toUpperCase() || 'Code')
}

/**
 * Extract the filename from a path for display.
 */
function getFilename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path
}

/**
 * Parse tool blocks from raw streaming text.
 * Handles both complete and partial (still streaming) blocks.
 */
interface ParsedSegment {
  type: 'prose' | 'code'
  content: string
  tool?: string
  path?: string
  isPartial?: boolean // true if the closing tag hasn't arrived yet
}

const FILE_TOOLS = ['file_write', 'file_create', 'file_edit', 'apply_patch']

function parseStreamingContent(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = []

  // Match XML tool blocks: <tool_name>...<path>...</path>...<content>...</content>...</tool_name>
  // Also handle partial blocks where closing tag hasn't arrived
  const toolPattern = new RegExp(
    `<(${FILE_TOOLS.join('|')})>([\\s\\S]*?)(?:<\\/\\1>|$)`,
    'g'
  )

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = toolPattern.exec(text)) !== null) {
    // Prose before this tool block
    if (match.index > lastIndex) {
      const prose = text.slice(lastIndex, match.index).trim()
      if (prose) {
        segments.push({ type: 'prose', content: prose })
      }
    }

    const toolName = match[1]
    const innerContent = match[2]
    const isPartial = !text.includes(`</${toolName}>`, match.index)

    // Extract path
    const pathMatch = innerContent.match(/<path>([\s\S]*?)<\/path>/)
    const filePath = pathMatch?.[1]?.trim() ?? ''

    // Extract content (may be partial — no closing tag yet)
    const contentMatch = innerContent.match(/<content>([\s\S]*?)(?:<\/content>|$)/)
    const codeContent = contentMatch?.[1] ?? ''

    segments.push({
      type: 'code',
      content: codeContent,
      tool: toolName,
      path: filePath,
      isPartial,
    })

    lastIndex = match.index + match[0].length
  }

  // Remaining prose after last tool block
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim()
    if (remaining) {
      segments.push({ type: 'prose', content: remaining })
    }
  }

  // If no tool blocks found, return the whole thing as prose
  if (segments.length === 0 && text.trim()) {
    segments.push({ type: 'prose', content: text })
  }

  return segments
}

/**
 * Code card with auto-scrolling, fixed height, and writing cursor.
 */
function CodeBlock({ segment }: { segment: ParsedSegment & { type: 'code' } }) {
  const codeRef = useRef<HTMLPreElement>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [copied, setCopied] = useState(false)

  const filename = segment.path ? getFilename(segment.path) : 'output'
  const language = segment.path ? getLanguageFromPath(segment.path) : 'Code'
  const lineCount = segment.content.split('\n').length

  // Auto-scroll to bottom as content streams in
  useEffect(() => {
    if (codeRef.current && segment.isPartial && !collapsed) {
      codeRef.current.scrollTop = codeRef.current.scrollHeight
    }
  }, [segment.content, segment.isPartial, collapsed])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(segment.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }

  const toolLabel = segment.tool === 'file_edit' ? 'Editing' :
    segment.tool === 'apply_patch' ? 'Patching' :
    segment.tool === 'file_create' ? 'Creating' : 'Writing'

  return (
    <div className="mt-2 mb-2 rounded-lg border border-white/[0.08] bg-[#0d1117] overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.03] border-b border-white/[0.06]">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            {collapsed
              ? <ChevronRight className="w-3.5 h-3.5" />
              : <ChevronDown className="w-3.5 h-3.5" />
            }
          </button>
          <FileCode2 className="w-3.5 h-3.5 text-accent/70 flex-shrink-0" />
          <span className="text-[11px] text-gray-300 font-medium truncate">{filename}</span>
          <span className="text-[9px] text-gray-600 flex-shrink-0">{language}</span>
          {segment.isPartial && (
            <span className="text-[9px] text-accent/70 flex-shrink-0 animate-pulse">
              {toolLabel}...
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[9px] text-gray-600">{lineCount} lines</span>
          <button
            onClick={handleCopy}
            className="text-gray-600 hover:text-gray-300 transition-colors"
            title="Copy code"
          >
            {copied
              ? <Check className="w-3.5 h-3.5 text-emerald-400" />
              : <Copy className="w-3.5 h-3.5" />
            }
          </button>
        </div>
      </div>

      {/* Code content */}
      {!collapsed && (
        <pre
          ref={codeRef}
          className="px-3 py-2 max-h-[280px] overflow-y-auto overflow-x-auto"
        >
          <code className="text-[12px] leading-[1.6] font-mono text-gray-300 whitespace-pre">
            {segment.content}
          </code>
          {/* Writing cursor */}
          {segment.isPartial && (
            <span className="inline-block w-[6px] h-[14px] bg-accent/70 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
          )}
        </pre>
      )}

      {/* Path footer (only if there's a full path and it's different from filename) */}
      {segment.path && segment.path !== filename && !collapsed && (
        <div className="px-3 py-1 border-t border-white/[0.04] bg-white/[0.015]">
          <span className="text-[9px] text-gray-600 font-mono truncate block">{segment.path}</span>
        </div>
      )}
    </div>
  )
}

/**
 * Streaming content renderer — parses raw LLM output into prose + code cards.
 * Replaces the plain Markdown renderer for streaming text that contains tool calls.
 */
export function StreamingContent({ text }: { text: string }) {
  const segments = parseStreamingContent(text)

  return (
    <div>
      {segments.map((segment, i) => {
        if (segment.type === 'code') {
          return <CodeBlock key={i} segment={segment as ParsedSegment & { type: 'code' }} />
        }
        return (
          <div key={i}>
            <Markdown content={segment.content} />
          </div>
        )
      })}
    </div>
  )
}
