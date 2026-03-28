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
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS findings_diffs (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, turn_id INTEGER NOT NULL REFERENCES turns (id) ON DELETE CASCADE
	, type TEXT NOT NULL CHECK (type IN ('edit', 'create', 'delete'))
	, file_path TEXT NOT NULL
	, patch TEXT
	, status TEXT NOT NULL DEFAULT 'proposed' CHECK (
		status IN ('proposed', 'accepted', 'rejected', 'modified')
	)
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS findings_commands (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, turn_id INTEGER NOT NULL REFERENCES turns (id) ON DELETE CASCADE
	, type TEXT NOT NULL CHECK (type IN ('run', 'env'))
	, command TEXT NOT NULL
	, status TEXT NOT NULL DEFAULT 'proposed' CHECK (
		status IN ('proposed', 'accepted', 'rejected')
	)
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS findings_notifications (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, turn_id INTEGER NOT NULL REFERENCES turns (id) ON DELETE CASCADE
	, type TEXT NOT NULL
	, text TEXT NOT NULL
	, level TEXT
	, status TEXT NOT NULL DEFAULT 'proposed' CHECK (
		status IN ('proposed', 'acknowledged', 'responded')
	)
	, config JSON
	, append BOOLEAN
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- THE STATE LOCK TRIGGER
CREATE TRIGGER IF NOT EXISTS lock_turn_on_pending_actions
BEFORE INSERT ON turns
FOR EACH ROW
BEGIN
	SELECT CASE
		WHEN (
			SELECT COUNT(*) FROM findings_diffs
			WHERE run_id = NEW.run_id AND status = 'proposed'
		) > 0
			THEN RAISE(ABORT, 'Blocked: Run has outstanding proposed diffs.')
		WHEN (
			SELECT COUNT(*) FROM findings_commands
			WHERE run_id = NEW.run_id AND status = 'proposed'
		) > 0
			THEN RAISE(ABORT, 'Blocked: Run has outstanding proposed commands.')
		WHEN (
			SELECT COUNT(*) FROM findings_notifications
			WHERE run_id = NEW.run_id AND status = 'proposed' AND type = 'prompt_user'
		) > 0
			THEN RAISE(ABORT, 'Blocked: Run has outstanding proposed user prompts.')
	END;
END;

-- Repo Map: File Metadata (no visibility state — that lives in file_promotions)
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

-- Client Promotions: user intent about file visibility
-- (by path, no FK to file index)
CREATE TABLE IF NOT EXISTS client_promotions (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE
	, path TEXT NOT NULL
	, constraint_type TEXT NOT NULL CHECK (
		constraint_type IN ('full', 'full:readonly', 'excluded')
	)
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	, UNIQUE (project_id, path)
);

-- File Promotions: agent and editor focus state (references indexed files)
-- agent: run-scoped (run_id set)
-- editor: turn-scoped, transient (run_id IS NULL, cleared each turn)
CREATE TABLE IF NOT EXISTS file_promotions (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, file_id INTEGER NOT NULL REFERENCES repo_map_files (id) ON DELETE CASCADE
	, source TEXT NOT NULL CHECK (source IN ('agent', 'editor'))
	, run_id TEXT REFERENCES runs (id) ON DELETE CASCADE
	, last_attention_turn INTEGER DEFAULT 0
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Editor promotions: project-scoped (run_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_promotions_project_unique
ON file_promotions (file_id, source) WHERE run_id IS NULL;
-- Agent promotions: run-scoped (run_id is set)
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_promotions_run_unique
ON file_promotions (file_id, source, run_id) WHERE run_id IS NOT NULL;

-- Pending Context: queued resolution info awaiting next turn
CREATE TABLE IF NOT EXISTS pending_context (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, source_turn_id INTEGER NOT NULL REFERENCES turns (id) ON DELETE CASCADE
	, type TEXT NOT NULL CHECK (type IN ('command', 'env', 'diff', 'notification'))
	, request TEXT NOT NULL
	, result TEXT NOT NULL
	, is_error BOOLEAN DEFAULT 0
	, consumed_by_turn_id INTEGER REFERENCES turns (id) ON DELETE SET NULL
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pending_context_run
ON pending_context (run_id, consumed_by_turn_id);

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

-- FINDINGS VIEWS
CREATE VIEW IF NOT EXISTS v_unresolved_findings AS
SELECT
	run_id
	, 'diff' as category
	, id
	, type
	, file_path as file
	, patch
	, status
	, turn_id
	, NULL as config
FROM findings_diffs WHERE status = 'proposed'
UNION ALL
SELECT
	run_id
	, 'command' as category
	, id
	, type
	, NULL as file
	, command as patch
	, status
	, turn_id
	, NULL as config
FROM findings_commands WHERE status = 'proposed'
UNION ALL
SELECT
	run_id
	, 'notification' as category
	, id
	, type
	, NULL as file
	, text as patch
	, status
	, turn_id
	, config
FROM findings_notifications WHERE status = 'proposed';

-- TURN HISTORY VIEW
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
CREATE INDEX IF NOT EXISTS idx_file_promotions_file ON file_promotions (
	file_id
);
CREATE INDEX IF NOT EXISTS idx_file_promotions_source ON file_promotions (
	source
);
CREATE INDEX IF NOT EXISTS idx_file_promotions_run ON file_promotions (run_id);
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
CREATE INDEX IF NOT EXISTS idx_findings_diffs_run_status ON findings_diffs (
	run_id, status
);
CREATE INDEX IF NOT EXISTS idx_findings_cmds_run_status ON findings_commands (
	run_id, status
);
CREATE INDEX IF NOT EXISTS idx_findings_notifs_run
ON findings_notifications (run_id, status);
