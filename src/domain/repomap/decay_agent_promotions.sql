-- PREP: decay_agent_promotions
DELETE FROM file_promotions
WHERE
	source = 'agent'
	AND file_id IN (
		SELECT f.id FROM repo_map_files AS f
		WHERE f.project_id = :project_id
	)
	AND (:current_turn - last_attention_turn) > :decay_threshold;
