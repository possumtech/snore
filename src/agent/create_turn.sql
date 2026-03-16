-- PREP: create_turn
INSERT INTO turns (
	run_id
	, sequence_number
	, payload
	, usage
	, prompt_tokens
	, completion_tokens
	, total_tokens
)
VALUES (
	:run_id
	, :sequence_number
	, :payload
	, :usage
	, :prompt_tokens
	, :completion_tokens
	, :total_tokens
);
