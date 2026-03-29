-- PREP: clear_repo_map_tags
DELETE FROM repo_map_tags
WHERE file_id = :file_id;
