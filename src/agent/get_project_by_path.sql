-- PREP: get_project_by_path
SELECT
	id
	, path
	, name
	, repo_map
	, last_git_hash
	, last_indexed_at
	, metadata
	, created_at
FROM projects
WHERE path = :path;
