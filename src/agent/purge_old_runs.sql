-- PREP: purge_old_runs
-- Delete completed/aborted runs older than :retention_days.
-- Cascades handle turns and known_entries.
DELETE FROM runs
WHERE
	status IN ('completed', 'aborted')
	AND created_at < datetime('now', '-' || :retention_days || ' days');
