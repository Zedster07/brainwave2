import { Migration } from '../migrations'

/**
 * Migration 003 — Confidence Calibration
 * Adds confidence tracking and user feedback to agent_runs table
 * for building a closed-loop calibration system.
 */
const migration: Migration = {
  version: 3,
  name: 'confidence_calibration',
  up: `
    -- Add confidence score to agent_runs (0.0–1.0)
    ALTER TABLE agent_runs ADD COLUMN confidence REAL;

    -- User feedback: 'positive', 'negative', or null (no feedback yet)
    ALTER TABLE agent_runs ADD COLUMN user_feedback TEXT CHECK(user_feedback IN ('positive', 'negative'));

    -- Index for calibration queries (agent + feedback)
    CREATE INDEX idx_agent_runs_confidence ON agent_runs(agent_type, confidence);
    CREATE INDEX idx_agent_runs_feedback ON agent_runs(agent_type, user_feedback);
  `,
  down: `
    DROP INDEX IF EXISTS idx_agent_runs_feedback;
    DROP INDEX IF EXISTS idx_agent_runs_confidence;
    -- SQLite < 3.35 doesn't support DROP COLUMN; safe to leave columns
  `,
}

export default migration
