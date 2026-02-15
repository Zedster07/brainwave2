import { Migration } from '../migrations'

/**
 * Migration 006 — Session types
 * Separates user chat sessions from autonomous (cron job) sessions
 */
const migration: Migration = {
  version: 6,
  name: 'session_type',
  up: `
    ALTER TABLE chat_sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'user';
    CREATE INDEX idx_sessions_type ON chat_sessions(session_type);
  `,
  down: `
    DROP INDEX IF EXISTS idx_sessions_type;
    -- SQLite < 3.35 doesn't support DROP COLUMN; column remains but unused
  `,
}

export default migration
