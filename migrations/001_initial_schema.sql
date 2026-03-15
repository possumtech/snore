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
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY
	, session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE
	, parent_job_id TEXT REFERENCES jobs (id) ON DELETE SET NULL
	, type TEXT NOT NULL CHECK (
		type IN ('orchestrator', 'task', 'ask', 'act')
	)
	, status TEXT NOT NULL DEFAULT 'queued' CHECK (
		status IN ('queued', 'running', 'completed', 'failed')
	)
	, config JSON
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS turns (
	id INTEGER PRIMARY KEY AUTOINCREMENT
	, job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE
	, sequence_number INTEGER NOT NULL
	, payload JSON NOT NULL
	, usage JSON
	, prompt_tokens INTEGER DEFAULT 0
	, completion_tokens INTEGER DEFAULT 0
	, total_tokens INTEGER DEFAULT 0
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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
CREATE INDEX IF NOT EXISTS idx_jobs_session_id ON jobs (session_id);
CREATE INDEX IF NOT EXISTS idx_repo_map_files_project_id
ON repo_map_files (project_id);
CREATE INDEX IF NOT EXISTS idx_repo_map_tags_file_id ON repo_map_tags (file_id);

-- Initial Data
INSERT OR IGNORE INTO projects (id, path, name)
VALUES
('snore-project', '/home/frith/repo/snore/main', 'SNORE Main');
