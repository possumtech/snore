-- PREP: upsert_client_promotion_by_pattern
INSERT INTO file_promotions (file_id, source, constraint_type)
SELECT f.id, 'client', :constraint_type
FROM repo_map_files AS f
WHERE f.project_id = :project_id AND f.path GLOB :pattern
ON CONFLICT (file_id, source) DO UPDATE SET
	constraint_type = EXCLUDED.constraint_type;
