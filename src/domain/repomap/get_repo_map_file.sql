-- PREP: get_repo_map_file
SELECT
	id
	, hash
	, size
	, visibility
	, symbol_tokens
FROM repo_map_files
WHERE
	project_id = :project_id
	AND path = :path;
