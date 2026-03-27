-- PREP: clear_repo_map_file_data
DELETE FROM repo_map_tags
WHERE file_id = :file_id;
-- SQLFLUFF: ignore
DELETE FROM repo_map_references
WHERE file_id = :file_id;
