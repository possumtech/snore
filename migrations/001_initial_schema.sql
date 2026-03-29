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
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_runs_alias ON runs (alias);

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

CREATE TABLE IF NOT EXISTS turn_elements (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, turn_id INTEGER NOT NULL REFERENCES turns (id) ON DELETE CASCADE
	, parent_id INTEGER REFERENCES turn_elements (id) ON DELETE CASCADE
	, tag_name TEXT NOT NULL
	, content TEXT
	, attributes JSON
	, sequence INTEGER NOT NULL
);

-- Repo Map: File Metadata (indexing infrastructure — bootstrap reads from this)
CREATE TABLE IF NOT EXISTS repo_map_files (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE
	, path TEXT NOT NULL
	, hash TEXT
	, size INTEGER DEFAULT 0
	, symbol_tokens INTEGER DEFAULT 0
	, is_root BOOLEAN GENERATED ALWAYS AS (path NOT LIKE '%/%') VIRTUAL
	, last_indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
	, UNIQUE (project_id, path)
);

CREATE TABLE IF NOT EXISTS repo_map_tags (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, file_id INTEGER NOT NULL REFERENCES repo_map_files (id) ON DELETE CASCADE
	, name TEXT NOT NULL
	, type TEXT NOT NULL
	, params TEXT
	, line INTEGER
	, source TEXT DEFAULT 'hd'
);

CREATE TABLE IF NOT EXISTS repo_map_references (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, file_id INTEGER NOT NULL REFERENCES repo_map_files (id) ON DELETE CASCADE
	, symbol_name TEXT NOT NULL
);

-- Canonical ranking query: src/domain/repomap/get_ranked_repo_map.sql

-- TURN HISTORY VIEW (debugging/UI — not on the LLM critical path)
CREATE VIEW IF NOT EXISTS v_turn_history AS
SELECT
	t.run_id,
	t.id as turn_id,
	t.sequence,
	'system' as role,
	te.content,
	0 as msg_index
FROM turns AS t
JOIN turn_elements AS te ON t.id = te.turn_id AND te.tag_name = 'system'
UNION ALL
SELECT
	t.run_id,
	t.id as turn_id,
	t.sequence,
	'user' as role,
	te.content,
	1 as msg_index
FROM turns AS t
JOIN turn_elements AS te ON t.id = te.turn_id AND te.tag_name = 'user'
UNION ALL
SELECT
	t.run_id,
	t.id as turn_id,
	t.sequence,
	'assistant' as role,
	te.content,
	2 as msg_index
FROM turns AS t
JOIN turn_elements AS te ON t.id = te.turn_id AND te.tag_name = 'content';

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions (project_id);
CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs (session_id);
CREATE INDEX IF NOT EXISTS idx_turns_run_seq ON turns (run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_repo_map_files_project ON repo_map_files (
	project_id
);
CREATE INDEX IF NOT EXISTS idx_repo_map_tags_file_name ON repo_map_tags (
	file_id, name
);
CREATE INDEX IF NOT EXISTS idx_repo_map_tags_name ON repo_map_tags (name);
CREATE INDEX IF NOT EXISTS idx_rmr_file_name
ON repo_map_references (file_id, symbol_name);
CREATE INDEX IF NOT EXISTS idx_rmr_symbol
ON repo_map_references (symbol_name);
CREATE INDEX IF NOT EXISTS idx_turn_elements_turn_parent ON turn_elements (
	turn_id, parent_id
);
CREATE INDEX IF NOT EXISTS idx_turn_elements_tag_lookup ON turn_elements (
	turn_id, tag_name
);

-- Known K/V Store: the unified state machine
-- Files, knowledge, tool results, findings — everything is a keyed entry.
-- domain + state are normalized columns; the model sees a projection (e.g. "file:symbols").
CREATE TABLE IF NOT EXISTS known_entries (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, turn_id INTEGER REFERENCES turns (id) ON DELETE CASCADE
	, key TEXT NOT NULL
	, value TEXT NOT NULL DEFAULT ''
	, domain TEXT NOT NULL CHECK (domain IN ('file', 'known', 'result'))
	, state TEXT NOT NULL
	, target TEXT NOT NULL DEFAULT ''
	, tool_call_id TEXT
	, write_count INTEGER NOT NULL DEFAULT 1
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	, CHECK (
		(domain = 'file' AND state IN ('full', 'readonly', 'active', 'ignore', 'symbols'))
		OR (domain = 'known' AND state IN ('full', 'stored'))
		OR (domain = 'result' AND state IN ('proposed', 'pass', 'info', 'warn', 'error', 'summary'))
	)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_known_entries_run_key
ON known_entries (run_id, key);
CREATE INDEX IF NOT EXISTS idx_known_entries_domain_state
ON known_entries (run_id, domain, state);

-- STATE LOCK TRIGGER: block new turns while results are pending approval
CREATE TRIGGER IF NOT EXISTS lock_turn_on_proposed
BEFORE INSERT ON turns
FOR EACH ROW
BEGIN
	SELECT CASE
		WHEN (
			SELECT COUNT(*) FROM known_entries
			WHERE run_id = NEW.run_id
				AND domain = 'result'
				AND state = 'proposed'
		) > 0
			THEN RAISE(ABORT, 'Blocked: Run has unresolved proposed entries.')
	END;
END;

-- UNRESOLVED VIEW: all entries awaiting user action
CREATE VIEW IF NOT EXISTS v_unresolved AS
SELECT
	run_id
	, key
	, value
	, target
	, tool_call_id
	, turn_id
FROM known_entries
WHERE domain = 'result' AND state = 'proposed';

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
