-- PREP: upsert_project
INSERT INTO projects (id, path, name, last_indexed_at)
VALUES (:id, :path, :name, CURRENT_TIMESTAMP)
ON CONFLICT (path) DO UPDATE SET
	name = excluded.name,
	last_indexed_at = CURRENT_TIMESTAMP;
