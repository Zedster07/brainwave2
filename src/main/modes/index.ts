/**
 * Modes System — Phase 11
 *
 * Modes define pre-configured agent + tool combinations for different workflows.
 * Each mode specifies which agent handles the task and which tool groups are available.
 *
 * Built-in modes: code, architect, ask, debug, orchestrator
 * Custom modes: loaded from `.brainwave/modes.json` in the project root
 *
 * Tool groups map to sets of local tool names, providing a clean abstraction
 * over the raw tool permission system.
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { AgentType } from '../agents/event-bus'

// ─── Types ──────────────────────────────────────────────────

/** Named groups of tools that can be assigned to modes */
export type ToolGroup = 'read' | 'edit' | 'command' | 'search' | 'browser' | 'mcp'

export interface ModeConfig {
  /** URL-safe identifier (e.g. 'code', 'architect') */
  slug: string
  /** Human-readable name */
  name: string
  /** Short description of the mode's purpose */
  description: string
  /** Primary agent type for this mode */
  agentType: AgentType
  /** Which tool groups are available in this mode */
  toolGroups: ToolGroup[]
  /** Custom system prompt override (prepended to agent's default prompt) */
  systemPromptOverride?: string
  /** Description of when this mode should be auto-selected by the orchestrator */
  whenToUse?: string
  /** Restrict file edits to files matching this regex pattern */
  fileRestrictions?: {
    editRegex?: string
  }
  /** Icon for UI display (emoji or lucide icon name) */
  icon?: string
  /** Whether this is a built-in mode (cannot be removed) */
  builtIn?: boolean
}

// ─── Tool Group → Tool Name Mappings ────────────────────────

/** Maps tool group names to sets of local tool names */
const TOOL_GROUP_MAP: Record<ToolGroup, string[]> = {
  read: [
    'file_read', 'directory_list', 'search_files', 'list_code_definition_names',
    'grep_search', 'git_info', 'repo_map', 'find_usage', 'get_file_diagnostics',
  ],
  edit: [
    'file_write', 'file_create', 'file_edit', 'file_delete', 'file_move',
    'apply_patch', 'create_directory',
    'generate_pdf', 'generate_docx', 'generate_xlsx', 'generate_pptx',
  ],
  command: [
    'shell_execute', 'shell_kill', 'run_test',
  ],
  search: [
    'web_search', 'webpage_fetch', 'http_request',
    'discover_tools',
  ],
  browser: [
    'web_search', 'webpage_fetch',
  ],
  mcp: [], // MCP tools are handled separately — all MCP tools allowed when this group is present
}

/** Resolve tool groups into a flat set of allowed local tool names */
export function resolveToolGroups(groups: ToolGroup[]): Set<string> {
  const tools = new Set<string>()
  // Always include meta tools available to all modes
  tools.add('ask_followup_question')
  tools.add('condense')
  tools.add('send_notification')

  for (const group of groups) {
    const groupTools = TOOL_GROUP_MAP[group]
    if (groupTools) {
      for (const tool of groupTools) {
        tools.add(tool)
      }
    }
  }
  return tools
}

/** Check if a mode allows MCP tools */
export function modeAllowsMcp(mode: ModeConfig): boolean {
  return mode.toolGroups.includes('mcp')
}

// ─── Built-in Modes ─────────────────────────────────────────

const BUILT_IN_MODES: ModeConfig[] = [
  {
    slug: 'code',
    name: 'Code',
    description: 'Full-featured coding agent — reads, writes, and runs code',
    agentType: 'coder',
    toolGroups: ['read', 'edit', 'command', 'search', 'mcp'],
    whenToUse: 'When the user wants to write, modify, or debug code',
    icon: '💻',
    builtIn: true,
  },
  {
    slug: 'architect',
    name: 'Architect',
    description: 'High-level design and planning — reads code, writes docs',
    agentType: 'coder',
    toolGroups: ['read', 'search'],
    fileRestrictions: { editRegex: '\\.md$' },
    whenToUse: 'When the user wants architectural decisions, design docs, or high-level planning without code changes',
    icon: '🏗️',
    builtIn: true,
  },
  {
    slug: 'ask',
    name: 'Ask',
    description: 'Answer questions using the codebase and web search',
    agentType: 'researcher',
    toolGroups: ['read', 'search', 'browser', 'mcp'],
    whenToUse: 'When the user asks questions about their code, searches for documentation, or wants explanations',
    icon: '❓',
    builtIn: true,
  },
  {
    slug: 'debug',
    name: 'Debug',
    description: 'Debug and fix issues — read, edit, and execute commands',
    agentType: 'executor',
    toolGroups: ['read', 'edit', 'command', 'search', 'mcp'],
    whenToUse: 'When the user reports a bug, error, or wants to troubleshoot an issue',
    icon: '🐛',
    builtIn: true,
  },
  {
    slug: 'orchestrator',
    name: 'Orchestrator',
    description: 'Delegate complex tasks to specialized agents',
    agentType: 'orchestrator',
    toolGroups: [],
    whenToUse: 'When the task is complex and requires multiple agents working together',
    icon: '🎯',
    builtIn: true,
  },
]

// ─── Mode Registry ──────────────────────────────────────────

class ModeRegistry {
  private modes = new Map<string, ModeConfig>()
  private projectDir: string | null = null

  constructor() {
    this.registerBuiltIns()
  }

  private registerBuiltIns(): void {
    for (const mode of BUILT_IN_MODES) {
      this.modes.set(mode.slug, mode)
    }
  }

  /** Set the project directory and load custom modes from `.brainwave/modes.json` */
  setProjectDir(dir: string): void {
    this.projectDir = dir
    this.loadCustomModes()
  }

  /** Load custom modes from `.brainwave/modes.json` in the project root */
  private loadCustomModes(): void {
    if (!this.projectDir) return

    const modesPath = join(this.projectDir, '.brainwave', 'modes.json')
    if (!existsSync(modesPath)) return

    try {
      const raw = readFileSync(modesPath, 'utf-8')
      const parsed = JSON.parse(raw) as { customModes?: Partial<ModeConfig>[] }

      if (!Array.isArray(parsed.customModes)) return

      for (const custom of parsed.customModes) {
        if (!custom.slug || !custom.name || !custom.agentType) {
          console.warn(`[ModeRegistry] Skipping invalid custom mode (missing slug/name/agentType):`, custom)
          continue
        }

        // Don't allow overriding built-in modes
        if (BUILT_IN_MODES.some((m) => m.slug === custom.slug)) {
          console.warn(`[ModeRegistry] Cannot override built-in mode "${custom.slug}"`)
          continue
        }

        const mode: ModeConfig = {
          slug: custom.slug,
          name: custom.name,
          description: custom.description ?? `Custom mode: ${custom.name}`,
          agentType: custom.agentType as AgentType,
          toolGroups: (custom.toolGroups ?? ['read']) as ToolGroup[],
          systemPromptOverride: custom.systemPromptOverride,
          whenToUse: custom.whenToUse,
          fileRestrictions: custom.fileRestrictions,
          icon: custom.icon ?? '🔧',
          builtIn: false,
        }

        this.modes.set(mode.slug, mode)
        console.log(`[ModeRegistry] Loaded custom mode: ${mode.slug} → ${mode.agentType}`)
      }
    } catch (err) {
      console.warn(`[ModeRegistry] Failed to load custom modes from ${modesPath}:`, err)
    }
  }

  /** Get a mode by slug */
  get(slug: string): ModeConfig | undefined {
    return this.modes.get(slug)
  }

  /** Get all available modes */
  getAll(): ModeConfig[] {
    return [...this.modes.values()]
  }

  /** Get built-in modes only */
  getBuiltIn(): ModeConfig[] {
    return BUILT_IN_MODES
  }

  /** Reload custom modes (after file change) */
  reload(): void {
    // Remove custom modes
    for (const [slug, mode] of this.modes) {
      if (!mode.builtIn) this.modes.delete(slug)
    }
    this.loadCustomModes()
  }
}

// ─── Singleton ──────────────────────────────────────────────

let registry: ModeRegistry | null = null

export function getModeRegistry(): ModeRegistry {
  if (!registry) {
    registry = new ModeRegistry()
  }
  return registry
}

export type { ModeRegistry }
