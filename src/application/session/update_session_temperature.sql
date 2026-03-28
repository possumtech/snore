-- PREP: update_session_temperature
UPDATE sessions
SET temperature = :temperature
WHERE id = :id;
