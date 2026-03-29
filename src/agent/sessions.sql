-- PREP: upsert_project
INSERT INTO projects (id, path, name)
VALUES (:id, :path, :name)
ON CONFLICT (path) DO UPDATE SET
	name = COALESCE(excluded.name, projects.name);

-- PREP: get_project_by_id
SELECT * FROM projects WHERE id = :id;

-- PREP: get_project_by_path
SELECT * FROM projects WHERE path = :path;

-- PREP: create_session
INSERT INTO sessions (id, project_id, client_id)
VALUES (:id, :project_id, :client_id);

-- PREP: get_session_by_id
SELECT * FROM sessions WHERE id = :id;

-- PREP: get_session_temperature
SELECT temperature FROM sessions WHERE id = :id;

-- PREP: update_session_temperature
UPDATE sessions SET temperature = :temperature WHERE id = :id;

-- PREP: update_session_system_prompt
UPDATE sessions SET system_prompt = :system_prompt WHERE id = :id;

-- PREP: update_session_persona
UPDATE sessions SET persona = :persona WHERE id = :id;

-- PREP: insert_session_skill
INSERT OR IGNORE INTO session_skills (session_id, name) VALUES (:session_id, :name);

-- PREP: delete_session_skill
DELETE FROM session_skills WHERE session_id = :session_id AND name = :name;

-- PREP: get_session_skills
SELECT name FROM session_skills WHERE session_id = :session_id;

-- PREP: purge_old_runs
-- Cascades handle turns and known_entries.
DELETE FROM runs
WHERE
	status IN ('completed', 'aborted')
	AND created_at < datetime('now', '-' || :retention_days || ' days');

-- PREP: purge_stale_sessions
DELETE FROM sessions
WHERE id NOT IN (SELECT DISTINCT session_id FROM runs);
