/**
 * Migration 009 — Token count cache
 *
 * Persists text→token-count mappings to avoid repeated tokenization on restart.
 * Uses a hash of the text as key to keep storage compact.
 */
import type { Migration } from '../migrations'

const migration: Migration = {
  version: 9,
  name: 'token_cache',
  up: `
    CREATE TABLE IF NOT EXISTS token_cache (
      text_hash   TEXT PRIMARY KEY,
      token_count INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
  down: `
    DROP TABLE IF EXISTS token_cache;
  `,
}

export default migration
