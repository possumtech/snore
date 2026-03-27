-- PREP: purge_old_runs
-- Delete completed/aborted runs older than :retention_days.
-- Cascades handle turns, turn_elements, findings_*,
-- pending_context, agent promotions.
DELETE FROM runs
WHERE
	status IN ('completed', 'aborted')
	AND created_at < datetime('now', '-' || :retention_days || ' days');
