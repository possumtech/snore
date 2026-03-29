-- PREP: get_run_log
SELECT key, state AS status, value, target
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'result'
ORDER BY id;
