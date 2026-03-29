-- EXEC: purge_stale_sessions
-- Delete sessions with no runs (orphaned by client disconnect).
DELETE FROM sessions
WHERE id NOT IN (SELECT DISTINCT session_id FROM runs);
