-- PREP: get_session_skills
SELECT name
FROM session_skills
WHERE session_id = :session_id
ORDER BY name;
