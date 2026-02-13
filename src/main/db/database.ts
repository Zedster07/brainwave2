import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

// ─── Database Configuration ─────────────────────────────────

export interface DatabaseConfig {
  /** Path to the .db file. Defaults to userData/brainwave2/brain.db */
  path?: string
  /** Enable WAL mode for better concurrent reads (default: true) */
  wal?: boolean
  /** Enable verbose logging (default: false in prod) */
  verbose?: boolean
}

// ─── Database Service ───────────────────────────────────────

export class DatabaseService {
  private db: Database.Database
  readonly path: string

  constructor(config: DatabaseConfig = {}) {
    // Resolve database path
    this.path = config.path ?? this.getDefaultPath()

    // Ensure directory exists
    const dir = this.path.substring(0, this.path.lastIndexOf('\\') > -1
      ? this.path.lastIndexOf('\\')
      : this.path.lastIndexOf('/'))
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    // Open database
    this.db = new Database(this.path, {
      verbose: config.verbose ? (msg) => console.log('[DB]', msg) : undefined,
    })

    // Performance pragmas
    if (config.wal !== false) {
      this.db.pragma('journal_mode = WAL')
    }
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('cache_size = -64000') // 64MB cache
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('temp_store = MEMORY')

    console.log(`[DB] Opened database: ${this.path}`)
  }

  // ─── Query Helpers ──────────────────────────────────────

  /** Execute a statement that doesn't return rows (INSERT, UPDATE, DELETE) */
  run(sql: string, ...params: unknown[]): Database.RunResult {
    return this.db.prepare(sql).run(...params)
  }

  /** Get a single row */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  /** Get all matching rows */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  /** Execute raw SQL (multiple statements — used for migrations) */
  exec(sql: string): void {
    this.db.exec(sql)
  }

  /** Run multiple operations in a transaction */
  transaction<T>(fn: () => T): T {
    const trx = this.db.transaction(fn)
    return trx()
  }

  /** Prepare a statement for repeated use */
  prepare(sql: string): Database.Statement {
    return this.db.prepare(sql)
  }

  /** Check if a table exists */
  tableExists(name: string): boolean {
    const row = this.get<{ count: number }>(
      `SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name=?`,
      name
    )
    return (row?.count ?? 0) > 0
  }

  /** Get database file size in bytes */
  getSize(): number {
    const row = this.get<{ size: number }>(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`)
    return row?.size ?? 0
  }

  /** Close the database connection */
  close(): void {
    this.db.close()
    console.log('[DB] Database closed')
  }

  /** Get the raw better-sqlite3 instance (for advanced ops) */
  raw(): Database.Database {
    return this.db
  }

  // ─── Private ────────────────────────────────────────────

  private getDefaultPath(): string {
    try {
      const userData = app.getPath('userData')
      return join(userData, 'brain.db')
    } catch {
      // Fallback for when app isn't ready (testing)
      return join(process.cwd(), 'brain.db')
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────

let dbInstance: DatabaseService | null = null

export function getDatabase(config?: DatabaseConfig): DatabaseService {
  if (!dbInstance) {
    dbInstance = new DatabaseService(config)
  }
  return dbInstance
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}
