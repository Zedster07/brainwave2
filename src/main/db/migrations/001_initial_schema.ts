import { Migration } from '../migrations'

/**
 * Initial schema — Memory system, Tasks, Agents, Scheduler persistence
 * Based on MEMORY_SYSTEM.md and AGENT_FRAMEWORK.md designs
 */
const migration: Migration = {
  version: 1,
  name: 'initial_schema',
  up: `
    -- ═══════════════════════════════════════════
    --  MEMORY TABLES
    -- ═══════════════════════════════════════════

    -- Episodic Memory: specific events / experiences
    CREATE TABLE episodic_memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '{}',       -- JSON: task_id, agent_id, trigger
      emotional_valence REAL DEFAULT 0.0,       -- -1.0 to 1.0
      importance REAL DEFAULT 0.5,              -- 0.0 to 1.0
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
      access_count INTEGER DEFAULT 0,
      decay_rate REAL DEFAULT 0.1,
      tags TEXT DEFAULT '[]',                   -- JSON array
      metadata TEXT DEFAULT '{}'                -- JSON blob
    );
    CREATE INDEX idx_episodic_importance ON episodic_memories(importance DESC);
    CREATE INDEX idx_episodic_timestamp ON episodic_memories(timestamp DESC);

    -- Semantic Memory: facts, knowledge, learned concepts
    CREATE TABLE semantic_memories (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,              -- 0.0 to 1.0
      source TEXT,                              -- where this was learned
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      access_count INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX idx_semantic_subject ON semantic_memories(subject);
    CREATE INDEX idx_semantic_predicate ON semantic_memories(predicate);
    CREATE INDEX idx_semantic_confidence ON semantic_memories(confidence DESC);

    -- Procedural Memory: how-to knowledge, learned procedures
    CREATE TABLE procedural_memories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      steps TEXT NOT NULL DEFAULT '[]',          -- JSON array of step objects
      trigger_conditions TEXT DEFAULT '[]',      -- JSON: when to use this procedure
      success_rate REAL DEFAULT 0.0,
      execution_count INTEGER DEFAULT 0,
      last_executed DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      tags TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX idx_procedural_name ON procedural_memories(name);
    CREATE INDEX idx_procedural_success ON procedural_memories(success_rate DESC);

    -- Prospective Memory: future intentions, reminders
    CREATE TABLE prospective_memories (
      id TEXT PRIMARY KEY,
      intention TEXT NOT NULL,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('time', 'event', 'condition')),
      trigger_value TEXT NOT NULL,              -- cron expr, event name, or condition JSON
      priority REAL DEFAULT 0.5,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'triggered', 'completed', 'expired')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      due_at DATETIME,
      completed_at DATETIME,
      tags TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX idx_prospective_status ON prospective_memories(status);
    CREATE INDEX idx_prospective_due ON prospective_memories(due_at);

    -- People Memory: knowledge about people the user interacts with
    CREATE TABLE people (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      relationship TEXT,
      traits TEXT DEFAULT '[]',                 -- JSON array
      preferences TEXT DEFAULT '{}',            -- JSON
      interaction_history TEXT DEFAULT '[]',     -- JSON array of interaction summaries
      last_interaction DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX idx_people_name ON people(name);

    -- Embeddings index for vector-like similarity searches
    CREATE TABLE embeddings_index (
      memory_id TEXT NOT NULL,
      memory_type TEXT NOT NULL,                -- episodic, semantic, procedural, prospective, people
      embedding_text TEXT NOT NULL,             -- text that was embedded
      embedding BLOB,                          -- binary embedding vector (float32 array)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (memory_id, memory_type)
    );

    -- Full-text search across all memory content
    CREATE VIRTUAL TABLE memory_fts USING fts5(
      memory_id,
      memory_type,
      content,
      tags,
      tokenize='porter unicode61'
    );

    -- ═══════════════════════════════════════════
    --  TASK & PLAN TABLES
    -- ═══════════════════════════════════════════

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      parent_id TEXT,                           -- for sub-tasks
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN (
        'pending', 'planning', 'in_progress', 'delegated',
        'blocked', 'completed', 'failed', 'cancelled'
      )),
      priority REAL DEFAULT 0.5,
      assigned_agent TEXT,                      -- agent type that owns this
      plan TEXT DEFAULT '[]',                   -- JSON: ordered steps
      result TEXT,                              -- JSON: outcome data
      error TEXT,                               -- error message if failed
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      metadata TEXT DEFAULT '{}',
      FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE INDEX idx_tasks_parent ON tasks(parent_id);
    CREATE INDEX idx_tasks_agent ON tasks(assigned_agent);
    CREATE INDEX idx_tasks_created ON tasks(created_at DESC);

    -- Task dependency edges (DAG)
    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on) REFERENCES tasks(id) ON DELETE CASCADE
    );

    -- ═══════════════════════════════════════════
    --  AGENT TABLES
    -- ═══════════════════════════════════════════

    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      task_id TEXT,
      status TEXT DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
      input TEXT DEFAULT '{}',                  -- JSON
      output TEXT,                              -- JSON
      llm_model TEXT,                           -- model used for this run
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0.0,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      error TEXT,
      metadata TEXT DEFAULT '{}',
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );
    CREATE INDEX idx_agent_runs_type ON agent_runs(agent_type);
    CREATE INDEX idx_agent_runs_task ON agent_runs(task_id);
    CREATE INDEX idx_agent_runs_started ON agent_runs(started_at DESC);

    -- ═══════════════════════════════════════════
    --  SCHEDULER PERSISTENCE
    -- ═══════════════════════════════════════════

    CREATE TABLE scheduled_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      schedule_type TEXT NOT NULL CHECK(schedule_type IN ('cron', 'interval', 'once')),
      schedule_value TEXT NOT NULL,             -- cron expr, ms interval, or ISO timestamp
      handler TEXT NOT NULL,                    -- handler identifier
      payload TEXT DEFAULT '{}',               -- JSON
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'failed')),
      last_run DATETIME,
      next_run DATETIME,
      run_count INTEGER DEFAULT 0,
      max_runs INTEGER,                        -- null = unlimited
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX idx_scheduled_status ON scheduled_jobs(status);
    CREATE INDEX idx_scheduled_next ON scheduled_jobs(next_run);

    -- ═══════════════════════════════════════════
    --  SETTINGS / KEY-VALUE STORE
    -- ═══════════════════════════════════════════

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,                     -- JSON-encoded value
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ═══════════════════════════════════════════
    --  RULES ENGINE
    -- ═══════════════════════════════════════════

    CREATE TABLE rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      trigger_event TEXT NOT NULL,             -- event name pattern
      conditions TEXT DEFAULT '[]',            -- JSON: condition expressions
      actions TEXT DEFAULT '[]',               -- JSON: action definitions
      priority INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX idx_rules_trigger ON rules(trigger_event);
    CREATE INDEX idx_rules_enabled ON rules(enabled);
  `,

  down: `
    DROP TABLE IF EXISTS rules;
    DROP TABLE IF EXISTS settings;
    DROP TABLE IF EXISTS scheduled_jobs;
    DROP TABLE IF EXISTS agent_runs;
    DROP TABLE IF EXISTS task_dependencies;
    DROP TABLE IF EXISTS tasks;
    DROP TABLE IF EXISTS memory_fts;
    DROP TABLE IF EXISTS embeddings_index;
    DROP TABLE IF EXISTS people;
    DROP TABLE IF EXISTS prospective_memories;
    DROP TABLE IF EXISTS procedural_memories;
    DROP TABLE IF EXISTS semantic_memories;
    DROP TABLE IF EXISTS episodic_memories;
  `
}

export default migration
