-- PREP: get_turns_by_job_id
SELECT
	id
	, job_id
	, sequence_number
	, payload
	, usage
	, prompt_tokens
	, completion_tokens
	, total_tokens
	, created_at
FROM turns
WHERE job_id = :job_id
ORDER BY sequence_number ASC;
