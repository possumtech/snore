-- PREP: update_files_visibility_by_pattern
UPDATE repo_map_files
SET
	visibility = :visibility
	, is_retained = (CASE WHEN :visibility = 'active' THEN 1 ELSE 0 END)
WHERE
	project_id = :project_id
	AND path GLOB :pattern;
