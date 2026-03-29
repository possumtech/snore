-- PREP: create_turn
INSERT INTO turns (run_id, sequence)
VALUES (:run_id, :sequence)
RETURNING id, sequence;

-- PREP: update_turn_stats
UPDATE turns
SET prompt_tokens = :prompt_tokens
	, completion_tokens = :completion_tokens
	, total_tokens = :total_tokens
	, cost = :cost
WHERE id = :id;

-- PREP: get_run_usage
SELECT
	COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens
	, COALESCE(SUM(completion_tokens), 0) AS completion_tokens
	, COALESCE(SUM(total_tokens), 0) AS total_tokens
	, COALESCE(SUM(cost), 0) AS cost
FROM turns
WHERE run_id = :run_id;

-- PREP: get_run_log
SELECT key, state AS status, value, meta
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'result'
ORDER BY id;
