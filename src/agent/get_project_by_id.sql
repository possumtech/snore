-- PREP: get_project_by_id
SELECT
	id
	, path
	, name
	, last_git_hash
	, last_indexed_at
	, created_at
FROM projects
WHERE id = :id;
