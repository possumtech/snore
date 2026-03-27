-- PREP: upsert_editor_promotion
INSERT INTO file_promotions (file_id, source)
SELECT f.id, 'editor'
FROM repo_map_files AS f
WHERE f.project_id = :project_id AND f.path = :path
ON CONFLICT (file_id, source) WHERE run_id IS NULL DO NOTHING;
