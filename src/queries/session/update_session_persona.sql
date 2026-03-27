-- PREP: update_session_persona
UPDATE sessions
SET persona = :persona
WHERE id = :id;