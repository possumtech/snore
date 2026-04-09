-- PREP: create_turn
INSERT INTO turns (run_id, loop_id, sequence)
VALUES (:run_id, :loop_id, :sequence)
RETURNING id, sequence;

-- PREP: update_turn_stats
UPDATE turns
SET
	reasoning_content = :reasoning_content
	, prompt_tokens = :prompt_tokens
	, cached_tokens = :cached_tokens
	, completion_tokens = :completion_tokens
	, reasoning_tokens = :reasoning_tokens
	, total_tokens = :total_tokens
	, cost = :cost
WHERE id = :id;

-- PREP: get_run_usage
SELECT
	COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens
	, COALESCE(SUM(cached_tokens), 0) AS cached_tokens
	, COALESCE(SUM(completion_tokens), 0) AS completion_tokens
	, COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens
	, COALESCE(SUM(total_tokens), 0) AS total_tokens
	, COALESCE(SUM(cost), 0) AS cost
FROM turns
WHERE run_id = :run_id;

-- PREP: get_run_log
SELECT ke.path, ke.status, ke.body, ke.attributes
FROM known_entries AS ke
JOIN schemes AS s ON s.name = COALESCE(ke.scheme, 'file')
WHERE
	ke.run_id = :run_id
	AND ke.scheme IS NOT NULL
	AND s.category NOT IN ('knowledge')
ORDER BY ke.id;
