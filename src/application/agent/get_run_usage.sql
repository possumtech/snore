-- PREP: get_run_usage
SELECT
	COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens
	, COALESCE(SUM(completion_tokens), 0) AS completion_tokens
	, COALESCE(SUM(total_tokens), 0) AS total_tokens
	, COALESCE(SUM(cost), 0) AS cost
FROM turns
WHERE run_id = :run_id;
