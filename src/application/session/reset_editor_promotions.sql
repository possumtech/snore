-- PREP: reset_editor_promotions
DELETE FROM file_promotions
WHERE source = 'editor' AND file_id IN (
	SELECT id FROM repo_map_files WHERE project_id = :project_id
);
