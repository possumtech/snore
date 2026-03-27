-- PREP: decay_agent_promotions
DELETE FROM file_promotions
WHERE
	source = 'agent'
	AND run_id = :run_id
	AND (:current_turn - last_attention_turn) > :decay_threshold;
