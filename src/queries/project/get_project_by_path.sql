-- PREP: get_project_by_path
SELECT
	id
	, path
	, name
	, last_git_hash
	, last_indexed_at
	, created_at
FROM projects
WHERE path = :path;
