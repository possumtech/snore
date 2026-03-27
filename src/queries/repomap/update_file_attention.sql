-- PREP: update_file_attention
UPDATE file_promotions
SET last_attention_turn = :turn_seq
WHERE
	source = 'agent'
	AND run_id = :run_id
	AND file_id IN (
		SELECT f.id
		FROM repo_map_files AS f
		WHERE
			f.project_id = :project_id
			AND (
				f.path = :mention
				OR f.id IN (
					SELECT file_id
					FROM repo_map_tags
					WHERE name = :mention
				)
			)
	);
