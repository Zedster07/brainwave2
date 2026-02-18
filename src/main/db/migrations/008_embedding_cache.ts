/**
 * Migration 008 — Embedding generation cache
 *
 * Persists text→embedding mappings to avoid redundant API calls on restart.
 * Uses a SHA-256 hash of the text as key to keep index compact.
 */
import type { Migration } from '../migrations'

const migration: Migration = {
  id: 8,
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
    DROP TABLE IF EXISTS embedding_cache;
  `,
}

export default migration
