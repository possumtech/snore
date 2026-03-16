-- PREP: create_run
INSERT INTO runs (
	id
	, session_id
	, parent_run_id
	, type
	, config
)
VALUES (
	:id
	, :session_id
	, :parent_run_id
	, :type
	, :config
);