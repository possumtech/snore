-- PREP: delete_client_promotion_by_pattern
DELETE FROM file_promotions
WHERE source = 'client' AND file_id IN (
	SELECT f.id FROM repo_map_files AS f
	WHERE f.project_id = :project_id AND f.path GLOB :pattern
);
