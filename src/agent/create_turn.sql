-- PREP: create_turn
INSERT INTO turns (
	job_id
	, sequence_number
	, payload
	, usage
	, prompt_tokens
	, completion_tokens
	, total_tokens
)
VALUES (
	:job_id
	, :sequence_number
	, :payload
	, :usage
	, :prompt_tokens
	, :completion_tokens
	, :total_tokens
);
