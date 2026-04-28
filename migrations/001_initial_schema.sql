-- INIT: enable_mmap
PRAGMA mmap_size = $mmap_size;

-- INIT: initial_schema

-- Scheme registry: single source of truth for all scheme metadata.
-- writable_by: JSON array of {system, plugin, client, model} — four writer tiers.
-- capability_class: optional restriction group (e.g. "shell", "files", "web")
-- so the policy plugin can compute the effective toolset from a run's
-- restriction list. Null means the scheme is always available.
CREATE TABLE IF NOT EXISTS schemes (
	name TEXT PRIMARY KEY
	, model_visible BOOLEAN NOT NULL DEFAULT 1
	, category TEXT
	, default_scope TEXT NOT NULL DEFAULT 'run'
	CHECK (default_scope IN ('run', 'project', 'global'))
	, writable_by JSON NOT NULL DEFAULT '["model","plugin"]'
	CHECK (json_valid(writable_by))
	, capability_class TEXT
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
-- Persists across runs. Orthogonal to visibility.
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

-- Entries: content-addressable by (scope, path). The actual payload.
-- scope: 'global' | 'project:N' | 'run:N'. Determines read access.
-- scheme: derived from path via schemeOf(). Generated column.
-- No visibility, status, turn, loop — those are view-side concerns.
CREATE TABLE IF NOT EXISTS entries (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, scope TEXT NOT NULL
	, path TEXT NOT NULL CHECK (length(path) <= 2048)
	, scheme TEXT GENERATED ALWAYS AS (schemeOf(path)) STORED
	, body TEXT NOT NULL DEFAULT ''
	, attributes JSON NOT NULL DEFAULT '{}' CHECK (json_valid(attributes))
	, hash TEXT
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_scope_path
ON entries (scope, path);
CREATE INDEX IF NOT EXISTS idx_entries_scope_scheme
ON entries (scope, scheme);

-- Run views: per-run projection of entries. State, visibility, turn live here.
-- A run has at most one view of any given entry. Absent view = not in context.
-- state: lifecycle. visibility: what the model sees. Orthogonal axes (SPEC §0.1).
-- outcome: short reason string when state ∈ {failed, cancelled}; NULL otherwise.
CREATE TABLE IF NOT EXISTS run_views (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, entry_id INTEGER NOT NULL REFERENCES entries (id) ON DELETE CASCADE
	, loop_id INTEGER REFERENCES loops (id) ON DELETE CASCADE
	, turn INTEGER NOT NULL DEFAULT 0 CHECK (turn >= 0)
	, state TEXT NOT NULL DEFAULT 'resolved' CHECK (
		state IN ('proposed', 'streaming', 'resolved', 'failed', 'cancelled')
	)
	, outcome TEXT
	, visibility TEXT NOT NULL DEFAULT 'visible' CHECK (
		visibility IN ('visible', 'summarized', 'archived')
	)
	, write_count INTEGER NOT NULL DEFAULT 1 CHECK (write_count >= 1)
	, refs INTEGER NOT NULL DEFAULT 0 CHECK (refs >= 0)
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_views_run_entry
ON run_views (run_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_run_views_run_turn
ON run_views (run_id, turn);
CREATE INDEX IF NOT EXISTS idx_run_views_run_visibility
ON run_views (run_id, visibility);

-- Legacy-shape compatibility view. Joins run_views to entries; reads
-- against this view keep one shape. Writes MUST target entries +
-- run_views directly.
CREATE VIEW IF NOT EXISTS known_entries AS
SELECT
	rv.id AS id
	, rv.run_id AS run_id
	, rv.loop_id AS loop_id
	, rv.turn AS turn
	, e.path AS path
	, e.body AS body
	, e.scheme AS scheme
	, rv.state AS state
	, rv.outcome AS outcome
	, rv.visibility AS visibility
	, e.hash AS hash
	, e.attributes AS attributes
	, rv.refs AS refs
	, rv.write_count AS write_count
	, e.created_at AS created_at
	, rv.updated_at AS updated_at
	, e.id AS entry_id
	, e.scope AS scope
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id;

-- UNRESOLVED VIEW: entries that haven't reached a terminal state.
-- Proposed (awaiting user decision) or streaming (in-flight).
CREATE VIEW IF NOT EXISTS v_unresolved AS
SELECT
	rv.run_id
	, e.path
	, e.body
	, e.attributes
	, rv.turn
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id
WHERE rv.state IN ('proposed', 'streaming');

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
	, state TEXT NOT NULL DEFAULT 'resolved' CHECK (
		state IN ('proposed', 'streaming', 'resolved', 'failed', 'cancelled')
	)
	, outcome TEXT
	-- 'archived' is permitted for one entry-type only: prompt://. Every
	-- other archived entry is filtered out by v_model_context. The
	-- prompt is run identity — even when archived, the model needs to
	-- see its path (without body) to recover. See prompt plugin README.
	, visibility TEXT NOT NULL CHECK (visibility IN ('visible', 'summarized', 'archived'))
	, body TEXT NOT NULL DEFAULT ''
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
