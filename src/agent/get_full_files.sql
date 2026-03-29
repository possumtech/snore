-- PREP: get_full_files
SELECT key, state, value
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'file'
	AND state != 'ignore'
	AND state != 'symbols'
	AND turn > 0
ORDER BY key;
