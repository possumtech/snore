-- PREP: get_run_log
SELECT key, state AS status, value, meta
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'result'
ORDER BY id;
