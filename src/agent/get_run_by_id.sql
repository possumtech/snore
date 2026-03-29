-- PREP: get_run_by_id
SELECT
	id
	, session_id
	, parent_run_id
	, type
	, status
	, config
	, alias
	, created_at
FROM runs
WHERE
	id = :id;