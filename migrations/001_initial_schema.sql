-- INIT: enable_mmap
PRAGMA mmap_size = $mmap_size;

-- INIT: initial_schema

-- Scheme registry: single source of truth for all scheme metadata.
-- Status codes are HTTP: 2xx success, 3xx redirect, 4xx model error, 5xx system error.
-- No valid_states — HTTP semantics are universal.
-- No fidelity — entries don't decide their own importance.
CREATE TABLE IF NOT EXISTS schemes (
	name TEXT PRIMARY KEY
	, model_visible BOOLEAN NOT NULL DEFAULT 1
	, category TEXT
);

-- Schemes are registered by plugins at startup via core.registerScheme().
-- Audit schemes are bootstrapped here since they have no plugin owner.

-- Projects: top-level organizational unit.
CREATE TABLE IF NOT EXISTS projects (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, name TEXT UNIQUE NOT NULL
	, project_root TEXT
	, config_path TEXT
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Models: available LLM configurations.
-- Populated from RUMMY_MODEL_* env vars at startup.
CREATE TABLE IF NOT EXISTS models (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, alias TEXT UNIQUE NOT NULL
	, actual TEXT NOT NULL
	, context_length INTEGER
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Runs: execution units belonging to a project.
-- Status uses HTTP codes: 100=queued, 102=running, 200=completed,
-- 202=proposed, 500=failed, 499=aborted.
CREATE TABLE IF NOT EXISTS runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE
	, parent_run_id INTEGER REFERENCES runs (id) ON DELETE SET NULL
	, model TEXT
	, status INTEGER NOT NULL DEFAULT 100 CHECK (status BETWEEN 100 AND 599)
	, alias TEXT NOT NULL UNIQUE
	, temperature REAL CHECK (
		temperature IS NULL OR (temperature >= 0 AND temperature <= 2)
	)
	, persona TEXT
	, context_limit INTEGER CHECK (context_limit IS NULL OR context_limit >= 1024)
	, next_turn INTEGER NOT NULL DEFAULT 1 CHECK (next_turn >= 1)
	, next_loop INTEGER NOT NULL DEFAULT 1 CHECK (next_loop >= 1)
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_runs_alias ON runs (alias);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs (project_id);

-- Loops: execution units within a run. Each ask/act call creates a loop.
-- Status: 100=pending, 102=running, 200=completed, 202=proposed,
-- 500=failed, 499=aborted.
CREATE TABLE IF NOT EXISTS loops (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, sequence INTEGER NOT NULL CHECK (sequence >= 1)
	, mode TEXT NOT NULL CHECK (mode IN ('ask', 'act'))
	, model TEXT
	, prompt TEXT NOT NULL DEFAULT ''
	, status INTEGER NOT NULL DEFAULT 100 CHECK (status BETWEEN 100 AND 599)
	, config JSON
	, result JSON
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	, UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_loops_run ON loops (run_id);
-- Enforce at most one running loop per run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_one_active
ON loops (run_id) WHERE status = 102;

-- Turns: usage stats and sequencing (operational, not model-facing)
CREATE TABLE IF NOT EXISTS turns (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, loop_id INTEGER NOT NULL REFERENCES loops (id) ON DELETE CASCADE
	, sequence INTEGER NOT NULL CHECK (sequence >= 1)
	, context_tokens INTEGER NOT NULL DEFAULT 0 CHECK (context_tokens >= 0)
	, reasoning_content TEXT
	, prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0)
	, cached_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0)
	, completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0)
	, reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0)
	, total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0)
	, cost REAL NOT NULL DEFAULT 0 CHECK (cost >= 0)
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_turns_run_seq ON turns (run_id, sequence);

-- File constraints: client-set visibility rules, project-scoped.
-- Persists across runs. Orthogonal to fidelity.
CREATE TABLE IF NOT EXISTS file_constraints (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE
	, pattern TEXT NOT NULL
	, visibility TEXT NOT NULL CHECK (visibility IN ('active', 'readonly', 'ignore'))
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	, UNIQUE (project_id, pattern)
);
CREATE INDEX IF NOT EXISTS idx_file_constraints_project
ON file_constraints (project_id);

-- Known K/V Store: the unified state machine.
-- Files, knowledge, tool results, audit — everything is a keyed entry.
-- scheme: derived from path via schemeOf(). Generated column.
-- status: HTTP status code (2xx success, 4xx model error, 5xx system error).
-- fidelity: visibility level, independently managed by relevance engine.
CREATE TABLE IF NOT EXISTS known_entries (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, loop_id INTEGER REFERENCES loops (id) ON DELETE CASCADE
	, turn INTEGER NOT NULL DEFAULT 0 CHECK (turn >= 0)
	, path TEXT NOT NULL CHECK (length(path) <= 2048)
	, body TEXT NOT NULL DEFAULT ''
	, scheme TEXT GENERATED ALWAYS AS (schemeOf(path)) STORED
	, status INTEGER NOT NULL DEFAULT 200 CHECK (status BETWEEN 100 AND 599)
	, fidelity TEXT NOT NULL DEFAULT 'full' CHECK (
		fidelity IN ('full', 'summary', 'index', 'archive')
	)
	, hash TEXT
	, attributes JSON NOT NULL DEFAULT '{}' CHECK (json_valid(attributes))
	, tokens INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0)
	, refs INTEGER NOT NULL DEFAULT 0 CHECK (refs >= 0)
	, write_count INTEGER NOT NULL DEFAULT 1 CHECK (write_count >= 1)
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_known_entries_run_path
ON known_entries (run_id, path);
CREATE INDEX IF NOT EXISTS idx_known_entries_scheme_status
ON known_entries (run_id, scheme, status);
CREATE INDEX IF NOT EXISTS idx_known_entries_turn
ON known_entries (run_id, turn);

-- No state validation triggers — HTTP status codes are universal.

-- UNRESOLVED VIEW: all entries awaiting user action (202 Accepted)
CREATE VIEW IF NOT EXISTS v_unresolved AS
SELECT
	run_id
	, path
	, body
	, attributes
	, turn
FROM known_entries
WHERE status = 202;

-- Turn context: materialized snapshot of what the model sees each turn.
-- known_entries is the warehouse. turn_context is the shipment.
CREATE TABLE IF NOT EXISTS turn_context (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, loop_id INTEGER REFERENCES loops (id) ON DELETE CASCADE
	, turn INTEGER NOT NULL CHECK (turn >= 1)
	, ordinal INTEGER NOT NULL CHECK (ordinal >= 0)
	, path TEXT NOT NULL
	, scheme TEXT GENERATED ALWAYS AS (schemeOf(path)) STORED
	, status INTEGER NOT NULL DEFAULT 200 CHECK (status BETWEEN 100 AND 599)
	, fidelity TEXT NOT NULL CHECK (fidelity IN ('full', 'summary', 'index'))
	, body TEXT NOT NULL DEFAULT ''
	, tokens INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0)
	, attributes JSON NOT NULL DEFAULT '{}' CHECK (json_valid(attributes))
	, category TEXT NOT NULL DEFAULT 'logging'
	, source_turn INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_turn_context_run_turn
ON turn_context (run_id, turn);

-- Enforce valid run state transitions (HTTP status codes).
-- 100=queued, 102=running, 200=completed, 202=proposed, 499=aborted, 500=failed.
CREATE TRIGGER IF NOT EXISTS trg_run_state_transition
BEFORE UPDATE OF status ON runs
FOR EACH ROW
WHEN OLD.status != NEW.status
BEGIN
	SELECT RAISE(ABORT, 'invalid run state transition')
	WHERE NOT (
		(OLD.status = 100 AND NEW.status IN (102, 499))
		OR (OLD.status = 102 AND NEW.status IN (200, 202, 500, 499))
		OR (OLD.status = 202 AND NEW.status IN (102, 200, 499))
		OR (OLD.status = 200 AND NEW.status IN (102, 499))
		OR (OLD.status = 500 AND NEW.status IN (102, 499))
		OR (OLD.status = 499 AND NEW.status IN (102))
	);
END;

-- Prompt queue is the loops table (defined above).
-- Each ask/act enqueues a loop (status=pending). Worker claims FIFO per run.

-- RPC audit log. Every call recorded unconditionally.
CREATE TABLE IF NOT EXISTS rpc_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, project_id INTEGER REFERENCES projects (id) ON DELETE CASCADE
	, method TEXT NOT NULL
	, rpc_id INTEGER
	, params JSON
	, result JSON
	, error TEXT
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rpc_log_project ON rpc_log (project_id);
CREATE INDEX IF NOT EXISTS idx_rpc_log_method ON rpc_log (method);
