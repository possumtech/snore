-- PREP: get_file_references
SELECT symbol_name
FROM repo_map_references
WHERE file_id = :file_id;
