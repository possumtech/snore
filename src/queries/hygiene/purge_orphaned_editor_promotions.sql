-- EXEC: purge_orphaned_editor_promotions
-- Delete editor promotions whose file_id no longer exists in repo_map_files.
-- Stale from crashed sessions or re-indexing.
DELETE FROM file_promotions
WHERE
	source = 'editor'
	AND file_id NOT IN (SELECT id FROM repo_map_files);
