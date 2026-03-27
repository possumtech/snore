-- PREP: insert_repo_map_ref
INSERT INTO repo_map_references (
	file_id,
	symbol_name
) VALUES (
	:file_id,
	:symbol_name
);
