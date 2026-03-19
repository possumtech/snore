-- PREP: upsert_project
INSERT INTO projects (id, path, name)
VALUES (:id, :path, :name)
ON CONFLICT (path) DO UPDATE SET
	name = EXCLUDED.name
RETURNING id;
