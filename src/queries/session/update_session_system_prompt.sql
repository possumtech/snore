-- PREP: update_session_system_prompt
UPDATE sessions
SET system_prompt = :system_prompt
WHERE id = :id;