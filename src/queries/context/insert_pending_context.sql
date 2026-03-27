-- PREP: insert_pending_context
INSERT INTO pending_context (
	run_id
	, source_turn_id
	, type
	, request
	, result
	, is_error
)
VALUES (
	:run_id
	, :source_turn_id
	, :type
	, :request
	, :result
	, :is_error
);
