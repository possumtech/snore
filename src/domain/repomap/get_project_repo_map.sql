-- PREP: get_project_repo_map
-- STUB: references removed. Returns basic file+tag data only.
SELECT
	f.id
	, f.path
	, f.size
	, f.hash
	, f.symbol_tokens
	, NULL AS client_constraint
	, t.name
	, t.type
	, t.params
	, t.line
	, t.source
	, 0 AS has_agent_promotion
	, 0 AS has_editor_promotion
FROM repo_map_files AS f
LEFT JOIN repo_map_tags AS t ON f.id = t.file_id
WHERE f.project_id = :project_id;
