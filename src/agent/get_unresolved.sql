-- PREP: get_unresolved
SELECT key, value, meta, turn
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'result'
	AND state = 'proposed';
