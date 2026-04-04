-- INIT: enable_mmap
PRAGMA mmap_size = 274877906944;

-- INIT: initial_schema

-- Scheme registry: single source of truth for all scheme metadata.
-- fidelity: 'full' = always visible, 'turn' = visible when turn>0, 'null' = never visible.
-- valid_states: JSON array of allowed state values for this scheme.
-- tier: demotion priority (0 = demote first under budget pressure).
CREATE TABLE IF NOT EXISTS schemes (
	name TEXT PRIMARY KEY
	, fidelity TEXT NOT NULL CHECK (fidelity IN ('full', 'turn', 'null'))
	, model_visible BOOLEAN NOT NULL DEFAULT 1
	, valid_states TEXT NOT NULL
	, tier INTEGER NOT NULL DEFAULT 0
	, category TEXT
);

INSERT OR IGNORE INTO schemes (name, fidelity, model_visible, valid_states, tier, category) VALUES
('file', 'turn', 1, '["full","summary","index","stored"]', 1, 'file'),
('known', 'turn', 1, '["full","stored"]', 2, 'knowledge'),
('unknown', 'full', 1, '["full","stored"]', 4, 'knowledge'),
('set', 'full', 1, '["full","proposed","pass","rejected","error","pattern"]', 0, 'result'),
('sh', 'full', 1, '["full","proposed","pass","rejected","error"]', 0, 'result'),
('env', 'full', 1, '["full","proposed","pass","rejected","error"]', 0, 'result'),
('rm', 'full', 1, '["full","proposed","pass","rejected","error","pattern"]', 0, 'result'),
('ask_user', 'full', 1, '["full","proposed","pass","rejected","error"]', 0, 'result'),
('mv', 'full', 1, '["full","proposed","pass","rejected","error","pattern"]', 0, 'result'),
('cp', 'full', 1, '["full","proposed","pass","rejected","error","pattern"]', 0, 'result'),
('get', 'full', 1, '["full","read","pattern"]', 0, 'result'),
('store', 'full', 1, '["full","stored","pattern"]', 0, 'result'),
('search', 'full', 1, '["full","info"]', 0, 'result'),
('summarize', 'full', 1, '["summary"]', 0, 'structural'),
('update', 'full', 1, '["info"]', 0, 'structural'),
('instructions', 'null', 0, '["info"]', 0, 'audit'),
('system', 'null', 0, '["info"]', 0, 'audit'),
('prompt', 'null', 0, '["info"]', 0, 'audit'),
('ask', 'full', 1, '["info"]', 0, 'audit'),
('act', 'full', 1, '["info"]', 0, 'audit'),
('progress', 'full', 1, '["info"]', 0, 'audit'),
('reasoning', 'null', 0, '["info"]', 0, 'audit'),
('model', 'null', 0, '["info"]', 0, 'audit'),
('error', 'null', 0, '["info"]', 0, 'audit'),
('user', 'null', 0, '["info"]', 0, 'audit'),
('assistant', 'null', 0, '["info"]', 0, 'audit'),
('content', 'null', 0, '["info"]', 0, 'audit'),
('tool', 'null', 0, '["full"]', 0, 'tool'),
('skill', 'full', 1, '["full","stored"]', 5, 'tool'),
('http', 'turn', 1, '["full","summary","stored"]', 1, 'file'),
('https', 'turn', 1, '["full","summary","stored"]', 1, 'file');

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
-- Each run has its own config (temperature, persona, context_limit).
CREATE TABLE IF NOT EXISTS runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE
	, parent_run_id INTEGER REFERENCES runs (id) ON DELETE SET NULL
	, model TEXT
	, status TEXT NOT NULL DEFAULT 'queued' CHECK (
		status IN ('queued', 'running', 'proposed', 'completed', 'failed', 'aborted')
	)
	, alias TEXT NOT NULL UNIQUE
	, temperature REAL CHECK (
		temperature IS NULL OR (temperature >= 0 AND temperature <= 2)
	)
	, persona TEXT
	, context_limit INTEGER CHECK (context_limit IS NULL OR context_limit >= 1024)
	, next_turn INTEGER NOT NULL DEFAULT 1 CHECK (next_turn >= 1)
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_runs_alias ON runs (alias);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs (project_id);

-- Turns: usage stats and sequencing (operational, not model-facing)
CREATE TABLE IF NOT EXISTS turns (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, sequence INTEGER NOT NULL CHECK (sequence >= 1)
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
-- State validated by trigger against schemes.valid_states.
CREATE TABLE IF NOT EXISTS known_entries (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, turn INTEGER NOT NULL DEFAULT 0 CHECK (turn >= 0)
	, path TEXT NOT NULL
	, body TEXT NOT NULL DEFAULT ''
	, scheme TEXT GENERATED ALWAYS AS (schemeOf(path)) STORED
	, state TEXT NOT NULL
	, hash TEXT
	, attributes JSON NOT NULL DEFAULT '{}' CHECK (json_valid(attributes))
	, tokens INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0)
	, tokens_full INTEGER NOT NULL DEFAULT 0 CHECK (tokens_full >= 0)
	, refs INTEGER NOT NULL DEFAULT 0 CHECK (refs >= 0)
	, write_count INTEGER NOT NULL DEFAULT 1 CHECK (write_count >= 1)
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_known_entries_run_path
ON known_entries (run_id, path);
CREATE INDEX IF NOT EXISTS idx_known_entries_scheme_state
ON known_entries (run_id, scheme, state);
CREATE INDEX IF NOT EXISTS idx_known_entries_turn
ON known_entries (run_id, turn);

-- Validate state against schemes.valid_states on insert.
CREATE TRIGGER IF NOT EXISTS trg_known_entry_state_insert
BEFORE INSERT ON known_entries
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'invalid state for scheme')
	WHERE NOT EXISTS (
		SELECT 1
		FROM schemes AS s, json_each(s.valid_states) AS j
		WHERE
			s.name = COALESCE(schemeOf(NEW.path), 'file')
			AND j.value = NEW.state
	);
END;

-- Validate state against schemes.valid_states on update.
CREATE TRIGGER IF NOT EXISTS trg_known_entry_state_update
BEFORE UPDATE OF state ON known_entries
FOR EACH ROW
WHEN OLD.state != NEW.state
BEGIN
	SELECT RAISE(ABORT, 'invalid state for scheme')
	WHERE NOT EXISTS (
		SELECT 1
		FROM schemes AS s, json_each(s.valid_states) AS j
		WHERE
			s.name = COALESCE(schemeOf(NEW.path), 'file')
			AND j.value = NEW.state
	);
END;

-- UNRESOLVED VIEW: all entries awaiting user action
CREATE VIEW IF NOT EXISTS v_unresolved AS
SELECT
	run_id
	, path
	, body
	, attributes
	, turn
FROM known_entries
WHERE state = 'proposed';

-- Turn context: materialized snapshot of what the model sees each turn.
-- known_entries is the warehouse. turn_context is the shipment.
CREATE TABLE IF NOT EXISTS turn_context (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, turn INTEGER NOT NULL CHECK (turn >= 1)
	, ordinal INTEGER NOT NULL CHECK (ordinal >= 0)
	, path TEXT NOT NULL
	, scheme TEXT GENERATED ALWAYS AS (schemeOf(path)) STORED
	, fidelity TEXT NOT NULL CHECK (fidelity IN ('full', 'summary', 'index'))
	, state TEXT NOT NULL DEFAULT 'full'
	, body TEXT NOT NULL DEFAULT ''
	, tokens INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0)
	, attributes JSON NOT NULL DEFAULT '{}' CHECK (json_valid(attributes))
	, category TEXT NOT NULL DEFAULT 'result'
	, source_turn INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_turn_context_run_turn
ON turn_context (run_id, turn);

-- Enforce valid run state transitions.
-- completed → running: continuation (new turn on finished run)
CREATE TRIGGER IF NOT EXISTS trg_run_state_transition
BEFORE UPDATE OF status ON runs
FOR EACH ROW
WHEN OLD.status != NEW.status
BEGIN
	SELECT RAISE(ABORT, 'invalid run state transition')
	WHERE NOT (
		(OLD.status = 'queued' AND NEW.status IN ('running', 'aborted'))
		OR (OLD.status = 'running' AND NEW.status IN ('proposed', 'completed', 'failed', 'aborted'))
		OR (OLD.status = 'proposed' AND NEW.status IN ('running', 'completed', 'aborted'))
		OR (OLD.status = 'completed' AND NEW.status IN ('running', 'aborted'))
		OR (OLD.status = 'failed' AND NEW.status IN ('running', 'aborted'))
		OR (OLD.status = 'aborted' AND NEW.status IN ('running'))
	);
END;

-- Prompt queue. All prompts flow through here. Worker consumes FIFO per run.
CREATE TABLE IF NOT EXISTS prompt_queue (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, mode TEXT NOT NULL CHECK (mode IN ('ask', 'act'))
	, model TEXT
	, prompt TEXT NOT NULL
	, config JSON
	, status TEXT NOT NULL DEFAULT 'pending'
	CHECK (status IN ('pending', 'active', 'completed', 'aborted'))
	, result JSON
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_prompt_queue_run ON prompt_queue (run_id, status);

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
