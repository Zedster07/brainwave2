/**
 * Migration 010 — Fix missing embedding_cache table
 *
 * Migration 008 was originally defined with `id` instead of `version`,
 * so it was silently skipped by the migration runner. This re-applies
 * the CREATE TABLE IF NOT EXISTS to fix existing installations.
 */
import type { Migration } from '../migrations'

const migration: Migration = {
  version: 10,
  name: 'fix_embedding_cache',
  up: `
    CREATE TABLE IF NOT EXISTS embedding_cache (
      text_hash   TEXT PRIMARY KEY,
      text_prefix TEXT NOT NULL,
      embedding   BLOB NOT NULL,
      dims        INTEGER NOT NULL DEFAULT 384,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_used   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_embedding_cache_last_used
      ON embedding_cache(last_used);
  `,
  down: `
    -- Don't drop — the table should persist
  `,
}

export default migration
