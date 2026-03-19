-- PREP: get_turns_by_run_id
SELECT
	id
	, run_id
	, sequence_number
	, payload
	, prompt_tokens
	, completion_tokens
	, total_tokens
	, created_at
FROM turns
WHERE
	run_id = :run_id
ORDER BY
	sequence_number ASC;