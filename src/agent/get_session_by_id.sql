-- PREP: get_session_by_id
SELECT
	id
	, project_id
	, client_id
	, created_at
FROM sessions
WHERE id = :id;
