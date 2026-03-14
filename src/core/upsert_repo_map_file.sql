-- PREP: upsert_repo_map_file
INSERT INTO repo_map_files (project_id, path, hash, size, last_indexed_at)
VALUES (:project_id, :path, :hash, :size, CURRENT_TIMESTAMP)
ON CONFLICT (project_id, path) DO UPDATE SET
	hash = EXCLUDED.hash
	, size = EXCLUDED.size
	, last_indexed_at = EXCLUDED.last_indexed_at
RETURNING id;
