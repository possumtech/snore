-- PREP: upsert_repo_map_file
INSERT INTO repo_map_files (
	project_id
	, path
	, hash
	, size
	, visibility
	, symbol_tokens
	, last_indexed_at
)
VALUES (
	:project_id
	, :path
	, :hash
	, :size
	, :visibility
	, :symbol_tokens
	, CURRENT_TIMESTAMP
)
ON CONFLICT (project_id, path) DO UPDATE SET
	hash = COALESCE(EXCLUDED.hash, hash)
	, size = COALESCE(EXCLUDED.size, size)
	, visibility = EXCLUDED.visibility
	, symbol_tokens = COALESCE(EXCLUDED.symbol_tokens, symbol_tokens)
	, last_indexed_at = EXCLUDED.last_indexed_at
RETURNING id;
