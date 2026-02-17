/**
 * Bundled MCP Servers — Hardcoded presets that ship with the app.
 *
 * Each preset defines the npx command, arguments, required env vars
 * (API keys / tokens), and optional user-configurable args.
 * Users toggle them on/off and fill in API keys from the Settings UI.
 * Enabled state + secrets are persisted in SQLite `settings` table.
 */

// ─── Types ──────────────────────────────────────────────────

export interface BundledEnvVar {
  /** Environment variable name (e.g. BRAVE_API_KEY) */
  key: string
  /** Human-readable label for the UI */
  label: string
  /** Input placeholder */
  placeholder: string
  /** If true, render as password field */
  secret: boolean
}

export interface BundledConfigArg {
  /** Key used in settings storage */
  key: string
  /** Human-readable label */
  label: string
  /** Default value */
  defaultValue: string
  /** Placeholder text */
  placeholder: string
  /** Brief description */
  description: string
}

export interface BundledServerPreset {
  /** Unique slug — used as stable ID (never changes) */
  id: string
  /** Display name */
  name: string
  /** One-line description */
  description: string
  /** NPM package or docker image */
  package: string
  /** Category for grouping */
  category: 'search' | 'browser' | 'coding' | 'filesystem' | 'database' | 'utility'
  /** The command to run */
  command: string
  /** Static args (before user-configurable args) */
  args: string[]
  /** Environment variables the user must provide (API keys etc.) */
  envVars: BundledEnvVar[]
  /** Extra user-configurable arguments (e.g. paths, DB URLs) */
  configArgs: BundledConfigArg[]
  /** Whether this preset is enabled by default (first launch) */
  defaultEnabled: boolean
}

// ─── Presets ────────────────────────────────────────────────

export const BUNDLED_SERVERS: BundledServerPreset[] = [
  // ── Search ──
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web and local search via the Brave Search API',
    package: '@modelcontextprotocol/server-brave-search',
    category: 'search',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envVars: [
      { key: 'BRAVE_API_KEY', label: 'Brave API Key', placeholder: 'BSA-xxxxxxxxxx', secret: true },
    ],
    configArgs: [],
    defaultEnabled: false,
  },
  {
    id: 'tavily-search',
    name: 'Tavily Search',
    description: 'AI-optimized search engine with web crawling',
    package: '@tavily/mcp-server',
    category: 'search',
    command: 'npx',
    args: ['-y', 'tavily-mcp@latest'],
    envVars: [
      { key: 'TAVILY_API_KEY', label: 'Tavily API Key', placeholder: 'tvly-xxxxxxxxxx', secret: true },
    ],
    configArgs: [],
    defaultEnabled: false,
  },

  // ── Browser ──
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Browser automation — navigate, click, screenshot, scrape',
    package: '@playwright/mcp',
    category: 'browser',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    envVars: [],
    configArgs: [],
    defaultEnabled: false,
  },

  // ── Coding ──
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date library documentation and code examples',
    package: '@upstash/context7-mcp',
    category: 'coding',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
    envVars: [],
    configArgs: [],
    defaultEnabled: false,
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Dynamic, reflective problem-solving through thought sequences',
    package: '@modelcontextprotocol/server-sequential-thinking',
    category: 'coding',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    envVars: [],
    configArgs: [],
    defaultEnabled: false,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repository management, issues, PRs, code search, and more',
    package: '@modelcontextprotocol/server-github',
    category: 'coding',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envVars: [
      { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub PAT', placeholder: 'ghp_xxxxxxxxxxxx', secret: true },
    ],
    configArgs: [],
    defaultEnabled: false,
  },

  // ── Filesystem ──
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Sandboxed file operations within allowed directories',
    package: '@modelcontextprotocol/server-filesystem',
    category: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    envVars: [],
    configArgs: [
      {
        key: 'allowed_dirs',
        label: 'Allowed Directories',
        defaultValue: '',
        placeholder: 'C:\\Users\\You\\Documents, D:\\Projects',
        description: 'Comma-separated list of directories the server can access',
      },
    ],
    defaultEnabled: false,
  },

  // ── Database ──
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Read/write SQLite databases with SQL queries',
    package: 'mcp-server-sqlite',
    category: 'database',
    command: 'uvx',
    args: ['mcp-server-sqlite'],
    envVars: [],
    configArgs: [
      {
        key: 'db_path',
        label: 'Database Path',
        defaultValue: '',
        placeholder: 'C:\\path\\to\\database.db',
        description: 'Path to the SQLite database file',
      },
    ],
    defaultEnabled: false,
  },

  // ── Utility ──
  {
    id: 'git',
    name: 'Git',
    description: 'Git repository operations — clone, commit, diff, log, branch',
    package: '@modelcontextprotocol/server-git',
    category: 'utility',
    command: 'uvx',
    args: ['mcp-server-git'],
    envVars: [],
    configArgs: [],
    defaultEnabled: false,
  },
]

// ─── Helpers ────────────────────────────────────────────────

/** Look up a bundled preset by ID */
export function getBundledPreset(id: string): BundledServerPreset | undefined {
  return BUNDLED_SERVERS.find((s) => s.id === id)
}

/** Persistence key for bundled server state in SQLite settings table */
export const BUNDLED_SETTINGS_KEY = 'bundled_mcp_state'

/**
 * Persisted state for each bundled server.
 * Stored as JSON in settings table under BUNDLED_SETTINGS_KEY.
 */
export interface BundledServerState {
  /** Map of preset ID → per-server state */
  servers: Record<string, {
    enabled: boolean
    /** User-provided env vars (API keys etc.) */
    envVars: Record<string, string>
    /** User-provided config args */
    configArgs: Record<string, string>
  }>
}

/** Default state — everything disabled, no keys */
export function getDefaultBundledState(): BundledServerState {
  const servers: BundledServerState['servers'] = {}
  for (const preset of BUNDLED_SERVERS) {
    servers[preset.id] = {
      enabled: preset.defaultEnabled,
      envVars: {},
      configArgs: Object.fromEntries(preset.configArgs.map((a) => [a.key, a.defaultValue])),
    }
  }
  return { servers }
}
