import { DatabaseService } from './database'

// ─── Migration Definition ───────────────────────────────────

export interface Migration {
  version: number
  name: string
  up: string   // SQL to apply
  down: string // SQL to rollback
}

// ─── Migration Runner ───────────────────────────────────────

export class MigrationRunner {
  constructor(private db: DatabaseService) {}

  /** Initialize the migrations tracking table */
  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
  }

  /** Get the current schema version */
  getCurrentVersion(): number {
    this.init()
    const row = this.db.get<{ version: number }>(
      `SELECT MAX(version) as version FROM _migrations`
    )
    return row?.version ?? 0
  }

  /** Run all pending migrations */
  migrate(migrations: Migration[]): { applied: string[]; current: number } {
    this.init()
    const currentVersion = this.getCurrentVersion()
    const pending = migrations
      .filter((m) => m.version > currentVersion)
      .sort((a, b) => a.version - b.version)

    if (pending.length === 0) {
      console.log(`[Migrations] Schema up to date at v${currentVersion}`)
      return { applied: [], current: currentVersion }
    }

    const applied: string[] = []

    for (const migration of pending) {
      console.log(`[Migrations] Applying v${migration.version}: ${migration.name}`)
      try {
        this.db.transaction(() => {
          this.db.exec(migration.up)
          this.db.run(
            `INSERT INTO _migrations (version, name) VALUES (?, ?)`,
            migration.version,
            migration.name
          )
        })
        applied.push(migration.name)
        console.log(`[Migrations] ✓ v${migration.version} applied`)
      } catch (err) {
        console.error(`[Migrations] ✗ v${migration.version} FAILED:`, err)
        throw err
      }
    }

    const newVersion = this.getCurrentVersion()
    console.log(`[Migrations] Schema at v${newVersion} (${applied.length} migrations applied)`)
    return { applied, current: newVersion }
  }

  /** Rollback the last migration */
  rollback(migrations: Migration[]): string | null {
    const currentVersion = this.getCurrentVersion()
    if (currentVersion === 0) return null

    const migration = migrations.find((m) => m.version === currentVersion)
    if (!migration) {
      throw new Error(`Migration v${currentVersion} not found in registry`)
    }

    console.log(`[Migrations] Rolling back v${migration.version}: ${migration.name}`)
    this.db.transaction(() => {
      this.db.exec(migration.down)
      this.db.run(`DELETE FROM _migrations WHERE version = ?`, migration.version)
    })

    console.log(`[Migrations] ✓ Rolled back to v${this.getCurrentVersion()}`)
    return migration.name
  }

  /** List all applied migrations */
  listApplied(): { version: number; name: string; applied_at: string }[] {
    this.init()
    return this.db.all(`SELECT * FROM _migrations ORDER BY version ASC`)
  }
}
