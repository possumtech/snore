-- INIT: initial_schema
CREATE TABLE IF NOT EXISTS models (
	id TEXT PRIMARY KEY
	, name TEXT NOT NULL
	, description TEXT
);

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
	, type TEXT NOT NULL CHECK (
		type IN ('orchestrator', 'task', 'ask', 'act')
	)
	, status TEXT NOT NULL DEFAULT 'queued' CHECK (
		status IN ('queued', 'running', 'proposed', 'completed', 'failed', 'aborted')
	)
	, config JSON
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS turns (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE
	, sequence_number INTEGER NOT NULL
	, payload JSON -- Keep for legacy/compatibility during transition
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
	, patch TEXT NOT NULL
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
-- Physically prevents starting a new turn if actions are unresolved.
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

-- Repo Map Tables
CREATE TABLE IF NOT EXISTS repo_map_files (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE
	, path TEXT NOT NULL
	, hash TEXT
	, size INTEGER DEFAULT 0
	, visibility TEXT NOT NULL DEFAULT 'mappable' CHECK (
		visibility IN ('active', 'read_only', 'mappable', 'ignored')
	)
	, symbol_tokens INTEGER DEFAULT 0
	, is_buffered BOOLEAN DEFAULT 0
	, is_retained BOOLEAN DEFAULT 0
	, last_attention_turn INTEGER DEFAULT 0
	, is_active BOOLEAN GENERATED ALWAYS AS (is_buffered OR is_retained) VIRTUAL
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

-- PROTOCOL CONSTRAINTS
CREATE TABLE IF NOT EXISTS protocol_constraints (
	type TEXT NOT NULL
	, has_unknowns BOOLEAN NOT NULL
	, required_tags TEXT NOT NULL
	, allowed_tags TEXT NOT NULL
	, PRIMARY KEY (type, has_unknowns)
);

INSERT OR IGNORE INTO protocol_constraints (
	type, has_unknowns, required_tags, allowed_tags
)
VALUES
(
	'ask'
	, 1
	, 'tasks known unknown'
	, 'tasks known unknown read drop env prompt_user summary'
),
(
	'ask'
	, 0
	, 'tasks known unknown'
	, 'tasks known unknown read drop env prompt_user summary'
),
(
	'act'
	, 1
	, 'tasks known unknown'
	, 'tasks known unknown read drop env prompt_user summary'
),
(
	'act'
	, 0
	, 'tasks known unknown'
	, 'tasks known unknown read drop env prompt_user edit create delete run '
	|| 'summary'
);

-- FILE TYPE HANDLERS (Symbol Extraction Strategy)
CREATE TABLE IF NOT EXISTS file_type_handlers (
	extension TEXT PRIMARY KEY
	, extractor TEXT NOT NULL CHECK (extractor IN ('hd', 'ctags'))
	, is_enabled BOOLEAN DEFAULT 1
);

INSERT OR IGNORE INTO file_type_handlers (extension, extractor, is_enabled)
VALUES
('js', 'hd', 1),
('ts', 'hd', 1),
('html', 'hd', 1),
('css', 'hd', 1),
('lua', 'ctags', 1),
('md', 'ctags', 1),
('txt', 'ctags', 0);

-- THE RANKING ENGINE (Heat Calculation)
-- Heat = (Count of symbols in THIS file matching references in ACTIVE files)
-- + (is_root ? 1 : 0)
CREATE VIEW IF NOT EXISTS repo_map_ranked AS
SELECT
	f.id,
	f.project_id,
	f.path,
	f.hash,
	f.size,
	f.visibility,
	f.symbol_tokens,
	f.is_buffered,
	f.is_retained,
	f.last_attention_turn,
	f.is_active,
	f.is_root,
	f.last_indexed_at,
	COALESCE((
		SELECT COUNT(DISTINCT t.name)
		FROM repo_map_tags AS t
		JOIN repo_map_references AS r ON t.name = r.symbol_name
		JOIN repo_map_files AS f2 ON r.file_id = f2.id
		WHERE
			t.file_id = f.id
			AND f2.is_active = 1
			AND f2.id != f.id
	), 0) + f.is_root AS heat
FROM repo_map_files AS f;

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
	run_id,
	sequence_number,
	key as msg_index,
	json_extract(value, '$.role') as role,
	json_extract(value, '$.content') as content
FROM turns, json_each(turns.payload)
WHERE json_extract(value, '$.role') IN ('user', 'assistant');

-- RELATIONAL TURN SUMMARY VIEW
CREATE VIEW IF NOT EXISTS v_turns_summary AS
SELECT
	t.id as turn_id,
	t.run_id,
	t.sequence_number,
	(
		SELECT content
		FROM turn_elements
		WHERE turn_id = t.id AND tag_name = 'reasoning_content'
		LIMIT 1
	) as reasoning
	,
	(
		SELECT content
		FROM turn_elements
		WHERE turn_id = t.id AND tag_name = 'content'
		LIMIT 1
	) as assistant_content
	,
	(
		SELECT content
		FROM turn_elements
		WHERE turn_id = t.id AND tag_name = 'tasks'
		LIMIT 1
	) as tasks_text
	,
	EXISTS(
		SELECT 1
		FROM turn_elements
		WHERE turn_id = t.id AND tag_name = 'tasks' AND content NOT LIKE '%- [ ]%'
	) as is_complete
FROM turns AS t;

CREATE TABLE IF NOT EXISTS system_hooks (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, hook_type TEXT NOT NULL CHECK (hook_type IN ('turn', 'filter', 'event'))
	, tag TEXT NOT NULL
	, priority INTEGER DEFAULT 10
	, description TEXT
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- INDEXES: INFRASTRUCTURE
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions (project_id);
CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs (session_id);
CREATE INDEX IF NOT EXISTS idx_turns_run_seq ON turns (run_id, sequence_number);

-- INDEXES: REPOMAP (Heat Engine)
CREATE INDEX IF NOT EXISTS idx_repo_map_files_project_active
ON repo_map_files (project_id, is_active);
CREATE INDEX IF NOT EXISTS idx_repo_map_tags_file_name
ON repo_map_tags (file_id, name);
CREATE INDEX IF NOT EXISTS idx_repo_map_tags_name ON repo_map_tags (name);
CREATE INDEX IF NOT EXISTS idx_repo_map_references_file_name
ON repo_map_references (file_id, symbol_name);
CREATE INDEX IF NOT EXISTS idx_repo_map_references_symbol
ON repo_map_references (symbol_name);

-- INDEXES: TURN ELEMENTS (Summary Engine)
CREATE INDEX IF NOT EXISTS idx_turn_elements_turn_parent
ON turn_elements (turn_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_turn_elements_tag_lookup
ON turn_elements (turn_id, tag_name);

-- INDEXES: FINDINGS
CREATE INDEX IF NOT EXISTS idx_findings_diffs_run_status
ON findings_diffs (run_id, status);
CREATE INDEX IF NOT EXISTS idx_findings_cmds_run_status
ON findings_commands (run_id, status);
CREATE INDEX IF NOT EXISTS idx_findings_notifs_run_status
ON findings_notifications (run_id, status);
