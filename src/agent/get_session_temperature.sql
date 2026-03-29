-- PREP: get_session_temperature
SELECT temperature
FROM sessions
WHERE id = :id;
