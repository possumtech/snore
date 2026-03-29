-- PREP: get_run_by_alias
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
	alias = :alias;
