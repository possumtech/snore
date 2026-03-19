-- PREP: create_turn
INSERT INTO turns (
	run_id
	, sequence_number
	, payload
	, prompt_tokens
	, completion_tokens
	, total_tokens
	, cost
) VALUES (
	:run_id
	, :sequence_number
	, :payload
	, :prompt_tokens
	, :completion_tokens
	, :total_tokens
	, :cost
) RETURNING id;
