-- PREP: get_project_references
SELECT
	f.path
	, r.symbol_name
FROM repo_map_files AS f
JOIN repo_map_references AS r
	ON f.id = r.file_id
WHERE f.project_id = :project_id;
