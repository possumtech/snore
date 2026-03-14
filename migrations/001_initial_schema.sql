-- INIT: initial_schema
CREATE TABLE IF NOT EXISTS models (
	id TEXT PRIMARY KEY
	, name TEXT NOT NULL
	, description TEXT
);

INSERT OR IGNORE INTO models (id, name, description)
VALUES
('gpt-4o', 'GPT-4o', 'OpenAI flagship model'),
(
	'claude-3-5-sonnet-latest'
	, 'Claude 3.5 Sonnet'
	, 'Anthropic performance model'
);

CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY
	, path TEXT UNIQUE NOT NULL
	, name TEXT
	, repo_map JSON
	, last_git_hash TEXT
	, last_indexed_at DATETIME
	, metadata JSON
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
	, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions (project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_session_id ON jobs (session_id);
CREATE INDEX IF NOT EXISTS idx_jobs_parent_job_id ON jobs (parent_job_id);
CREATE INDEX IF NOT EXISTS idx_turns_job_id ON turns (job_id);

-- Initial Data for testing
INSERT OR IGNORE INTO projects (id, path, name)
VALUES
('snore-project', '/home/frith/repo/snore/main', 'SNORE Main');
