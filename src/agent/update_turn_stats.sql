-- PREP: update_turn_stats
UPDATE turns
SET prompt_tokens = :prompt_tokens
	, completion_tokens = :completion_tokens
	, total_tokens = :total_tokens
	, cost = :cost
WHERE id = :id;
