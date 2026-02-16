import { useState } from 'react'
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Clock, Wrench, Eye, FileEdit, Terminal, Search, GitBranch, Send } from 'lucide-react'

export interface ToolCallCardData {
  taskId: string
  agentType: string
  step: number
  tool: string
  toolName: string
  args: Record<string, unknown>
  success: boolean
  summary: string
  duration?: number
  resultPreview?: string
  timestamp: number
}

// Map tool base names to icons
const TOOL_ICONS: Record<string, typeof Wrench> = {
  file_read: Eye,
  read_file: Eye,
  read_multiple_files: Eye,
  file_write: FileEdit,
  file_create: FileEdit,
  file_edit: FileEdit,
  apply_patch: FileEdit,
  shell_execute: Terminal,
  directory_list: Search,
  file_search: Search,
  grep_search: Search,
  search_files: Search,
  delegate_to_agent: Send,
  use_subagents: GitBranch,
}

function getToolIcon(toolName: string) {
  const Icon = TOOL_ICONS[toolName] ?? Wrench
  return Icon
}

function getToolColor(toolName: string, success: boolean): string {
  if (!success) return 'text-red-400'
  if (toolName.includes('read') || toolName.includes('list') || toolName.includes('search')) return 'text-blue-400'
  if (toolName.includes('write') || toolName.includes('create') || toolName.includes('edit') || toolName.includes('patch')) return 'text-emerald-400'
  if (toolName.includes('shell') || toolName.includes('execute')) return 'text-amber-400'
  if (toolName.includes('delegate') || toolName.includes('subagent')) return 'text-purple-400'
  return 'text-gray-400'
}

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return ''

  // For common tools, show the most relevant arg
  const path = args.path ?? args.file_path ?? args.filePath
  if (path) return String(path).replace(/\\/g, '/').split('/').slice(-2).join('/')

  const command = args.command
  if (command) return String(command).split('\n')[0].slice(0, 60)

  const query = args.query ?? args.search ?? args.pattern
  if (query) return `"${String(query).slice(0, 50)}"`

  // Generic: show first key=value
  const [key, val] = entries[0]
  const valStr = typeof val === 'string' ? val.slice(0, 40) : JSON.stringify(val)?.slice(0, 40) ?? ''
  return `${key}: ${valStr}`
}

export function ToolCallCard({ data, index }: { data: ToolCallCardData; index: number }) {
  const [expanded, setExpanded] = useState(false)

  const Icon = getToolIcon(data.toolName)
  const color = getToolColor(data.toolName, data.success)
  const argsPreview = formatArgs(data.args)
  const duration = formatDuration(data.duration)

  return (
    <div className="group">
      {/* Collapsed row — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-1.5 py-0.5 w-full text-left hover:bg-white/[0.02] rounded transition-colors"
      >
        <span className="text-[10px] font-mono text-gray-600 flex-shrink-0 mt-px w-4 text-right opacity-40">
          {index + 1}
        </span>

        {/* Expand indicator */}
        <span className="text-gray-600 flex-shrink-0 mt-px">
          {expanded
            ? <ChevronDown className="w-2.5 h-2.5" />
            : <ChevronRight className="w-2.5 h-2.5" />
          }
        </span>

        {/* Status icon */}
        <span className={`flex-shrink-0 mt-px ${color}`}>
          {data.success
            ? <CheckCircle2 className="w-3 h-3" />
            : <XCircle className="w-3 h-3" />
          }
        </span>

        {/* Tool icon */}
        <span className={`flex-shrink-0 mt-px ${color} opacity-70`}>
          <Icon className="w-3 h-3" />
        </span>

        {/* Tool name + summary */}
        <span className="flex-1 min-w-0">
          <span className={`text-[10px] font-medium ${color}`}>
            {data.toolName}
          </span>
          {argsPreview && (
            <span className="text-[10px] text-gray-500 ml-1.5 truncate">
              {argsPreview}
            </span>
          )}
        </span>

        {/* Duration */}
        {duration && (
          <span className="flex-shrink-0 flex items-center gap-0.5 text-[9px] text-gray-600">
            <Clock className="w-2.5 h-2.5" />
            {duration}
          </span>
        )}
      </button>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="ml-8 mt-1 mb-2 p-2 rounded-md bg-white/[0.02] border border-white/[0.05] space-y-1.5">
          {/* Summary line */}
          <div className="text-[10px] text-gray-400">
            {data.summary}
          </div>

          {/* Args table */}
          {Object.keys(data.args).length > 0 && (
            <div className="space-y-0.5">
              <div className="text-[9px] text-gray-600 uppercase tracking-wider font-medium">Arguments</div>
              <div className="max-h-[120px] overflow-y-auto">
                {Object.entries(data.args).map(([key, val]) => (
                  <div key={key} className="flex gap-2 text-[10px]">
                    <span className="text-cyan-400/60 flex-shrink-0 font-mono">{key}:</span>
                    <span className="text-gray-400 truncate font-mono">
                      {typeof val === 'string' ? val.slice(0, 200) : JSON.stringify(val)?.slice(0, 200) ?? ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Result preview */}
          {data.resultPreview && (
            <div className="space-y-0.5">
              <div className="text-[9px] text-gray-600 uppercase tracking-wider font-medium">Preview</div>
              <pre className="text-[9px] text-gray-500 font-mono whitespace-pre-wrap max-h-[100px] overflow-y-auto leading-relaxed">
                {data.resultPreview}
              </pre>
            </div>
          )}

          {/* Metadata */}
          <div className="flex items-center gap-3 text-[9px] text-gray-600">
            <span>Step {data.step}</span>
            <span>{data.agentType}</span>
            {data.timestamp && (
              <span>{new Date(data.timestamp).toLocaleTimeString()}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
