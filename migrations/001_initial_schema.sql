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
	, UNIQUE(session_id, name)
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
	, payload JSON NOT NULL
	, prompt_tokens INTEGER DEFAULT 0
	, completion_tokens INTEGER DEFAULT 0
	, total_tokens INTEGER DEFAULT 0
	, cost REAL DEFAULT 0
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions (project_id);
CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs (session_id);
CREATE INDEX IF NOT EXISTS idx_repo_map_files_project_id
ON repo_map_files (project_id);
CREATE INDEX IF NOT EXISTS idx_repo_map_tags_file_id ON repo_map_tags (file_id);

-- Initial Data
INSERT OR IGNORE INTO projects (id, path, name)
VALUES
('rummy-project', '/home/frith/repo/rummy/main', 'RUMMY Main');
