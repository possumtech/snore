-- PREP: update_file_attention
-- Bumps the last_attention_turn for files matching path or symbols
UPDATE repo_map_files
SET last_attention_turn = :turn_seq
WHERE
	project_id = :project_id
	AND (
		path = :mention
		OR id IN (SELECT file_id FROM repo_map_tags WHERE name = :mention)
	);
