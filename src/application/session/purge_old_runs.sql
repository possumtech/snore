-- EXEC: purge_old_runs
-- Delete completed/aborted runs older than 30 days.
-- Cascades handle turns, turn_elements, findings_*, pending_context, agent promotions.
DELETE FROM runs
WHERE status IN ('completed', 'aborted')
AND created_at < datetime('now', '-30 days');
