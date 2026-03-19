-- PREP: get_session_skills
SELECT
	id
	, session_id
	, name
	, created_at
FROM session_skills
WHERE session_id = :session_id;