import { Migration } from '../migrations'

/**
 * Migration 002 — Chat sessions for Command Center
 * Adds a sessions table and links tasks to sessions via session_id column
 */
const migration: Migration = {
  version: 2,
  name: 'chat_sessions',
  up: `
    -- Chat sessions — each is a separate conversation thread
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_sessions_updated ON chat_sessions(updated_at DESC);

    -- Link tasks to sessions
    ALTER TABLE tasks ADD COLUMN session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL;
    CREATE INDEX idx_tasks_session ON tasks(session_id);
  `,
  down: `
    DROP INDEX IF EXISTS idx_tasks_session;
    -- SQLite doesn't support DROP COLUMN before 3.35, so recreate table
    -- For simplicity, just drop the sessions table
    DROP TABLE IF EXISTS chat_sessions;
  `,
}

export default migration
