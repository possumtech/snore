-- PREP: get_runs_by_session
SELECT
	alias
	, type
	, status
	, config
	, created_at
FROM runs
WHERE session_id = :session_id
ORDER BY created_at DESC;
