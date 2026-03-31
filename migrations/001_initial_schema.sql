-- INIT: enable_mmap
PRAGMA mmap_size = 274877906944;

-- INIT: initial_schema
CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY
	, path TEXT UNIQUE NOT NULL
	, name TEXT
	, last_git_hash TEXT
	, last_indexed_at DATETIME
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY
	, project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE
	, client_id TEXT
	, persona TEXT
	, system_prompt TEXT
	, temperature REAL
	, context_limit INTEGER
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_skills (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE
	, name TEXT NOT NULL
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	, UNIQUE (session_id, name)
);

CREATE TABLE IF NOT EXISTS runs (
	id TEXT PRIMARY KEY
	, session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE
	, parent_run_id TEXT REFERENCES runs (id) ON DELETE SET NULL
	, type TEXT NOT NULL CHECK (type IN ('ask', 'act'))
	, status TEXT NOT NULL DEFAULT 'queued' CHECK (
		status IN ('queued', 'running', 'proposed', 'completed', 'failed', 'aborted')
	)
	, config JSON
	, alias TEXT NOT NULL UNIQUE
	, next_result_seq INTEGER NOT NULL DEFAULT 1
	, next_turn INTEGER NOT NULL DEFAULT 1
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_runs_alias ON runs (alias);

-- Turns: usage stats and sequencing (operational, not model-facing)
CREATE TABLE IF NOT EXISTS turns (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, sequence INTEGER NOT NULL
	, prompt_tokens INTEGER DEFAULT 0
	, completion_tokens INTEGER DEFAULT 0
	, total_tokens INTEGER DEFAULT 0
	, cost REAL DEFAULT 0
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_turns_run_seq ON turns (run_id, sequence);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions (project_id);
CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs (session_id);

-- Known K/V Store: the unified state machine
-- Files, knowledge, tool results, audit — everything is a keyed entry.
-- scheme: extracted from URI (known://, edit://, etc.)
-- NULL for bare file paths.
CREATE TABLE IF NOT EXISTS known_entries (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, turn INTEGER NOT NULL DEFAULT 0
	, path TEXT NOT NULL
	, value TEXT NOT NULL DEFAULT ''
	, scheme TEXT
	, state TEXT NOT NULL
	, hash TEXT
	, meta JSON
	, tokens INTEGER NOT NULL DEFAULT 0
	, refs INTEGER NOT NULL DEFAULT 0
	, write_count INTEGER NOT NULL DEFAULT 1
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	, CHECK (
		CASE
			WHEN scheme IS NULL
				THEN state IN ('full', 'readonly', 'active', 'ignore', 'symbols')
			WHEN scheme IN ('known', 'unknown')
				THEN state IN ('full', 'stored')
			WHEN scheme IN ('edit')
				THEN state IN ('proposed', 'pass', 'warn', 'error')
			WHEN scheme IN ('run', 'env', 'delete', 'ask_user')
				THEN state IN ('proposed', 'pass', 'warn')
			WHEN scheme IN ('read', 'drop')
				THEN state IN ('pass', 'info')
			WHEN scheme = 'summary'
				THEN state = 'summary'
			WHEN scheme IN ('system', 'user', 'reasoning', 'prompt', 'keys', 'inject')
				THEN state = 'info'
			WHEN scheme = 'retry'
				THEN state = 'error'
			WHEN scheme IN ('http', 'https')
				THEN state IN ('full', 'readonly')
			ELSE 0
		END
	)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_known_entries_run_path
ON known_entries (run_id, path);
CREATE INDEX IF NOT EXISTS idx_known_entries_scheme_state
ON known_entries (run_id, scheme, state);
CREATE INDEX IF NOT EXISTS idx_known_entries_turn
ON known_entries (run_id, turn);

-- UNRESOLVED VIEW: all entries awaiting user action
CREATE VIEW IF NOT EXISTS v_unresolved AS
SELECT
	run_id
	, path
	, value
	, meta
	, turn
FROM known_entries
WHERE state = 'proposed';

-- TURN HISTORY VIEW: reconstructed from known_entries
CREATE VIEW IF NOT EXISTS v_turn_history AS
SELECT
	run_id
	, turn
	, path
	, scheme
	, state
	, value
	, meta
FROM known_entries
ORDER BY run_id, turn, id;

-- Provider model catalog (cached from OpenRouter /models, etc.)
CREATE TABLE IF NOT EXISTS provider_models (
	id TEXT PRIMARY KEY
	, canonical_slug TEXT
	, name TEXT
	, description TEXT
	, context_length INTEGER
	, modality TEXT
	, tokenizer TEXT
	, instruct_type TEXT
	, input_modalities JSON
	, output_modalities JSON
	, pricing_prompt REAL
	, pricing_completion REAL
	, pricing_input_cache_read REAL
	, max_completion_tokens INTEGER
	, is_moderated BOOLEAN
	, supported_parameters JSON
	, default_parameters JSON
	, knowledge_cutoff TEXT
	, expiration_date TEXT
	, created INTEGER
	, fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
