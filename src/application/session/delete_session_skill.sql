-- PREP: delete_session_skill
DELETE FROM session_skills
WHERE session_id = :session_id AND name = :name;