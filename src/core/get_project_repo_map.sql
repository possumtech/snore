-- PREP: get_project_repo_map
SELECT
	f.path
	, f.size
	, t.name
	, t.type
	, t.params
	, t.line
	, t.source
FROM repo_map_files AS f
LEFT JOIN repo_map_tags AS t
	ON f.id = t.file_id
WHERE f.project_id = :project_id;
