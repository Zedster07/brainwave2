import { Migration } from '../migrations'

/**
 * Migration 004 — Prompt Versioning
 * Adds prompt_version column to agent_runs for tracking which prompt version
 * produced each result (enables reproducibility and A/B testing).
 */
const migration: Migration = {
  version: 4,
  name: 'prompt_versioning',
  up: `
    -- Track which prompt version produced each agent run
    ALTER TABLE agent_runs ADD COLUMN prompt_version TEXT;

    -- Index for querying runs by prompt version
    CREATE INDEX idx_agent_runs_prompt_version ON agent_runs(prompt_version);
  `,
  down: `
    DROP INDEX IF EXISTS idx_agent_runs_prompt_version;
  `,
}

export default migration
