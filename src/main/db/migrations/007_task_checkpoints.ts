import { Migration } from '../migrations'

/**
 * Migration 007 — Task checkpoints
 * Stores checkpoint snapshots created during agent tool execution
 * so users can roll back to any point during a task.
 */
const migration: Migration = {
  version: 7,
  name: 'task_checkpoints',
  up: `
    CREATE TABLE IF NOT EXISTS task_checkpoints (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      tool TEXT NOT NULL,
      file_path TEXT NOT NULL,
      commit_hash TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON task_checkpoints(task_id);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_step ON task_checkpoints(task_id, step);
  `,
  down: `
    DROP INDEX IF EXISTS idx_checkpoints_step;
    DROP INDEX IF EXISTS idx_checkpoints_task;
    DROP TABLE IF EXISTS task_checkpoints;
  `,
}

export default migration
