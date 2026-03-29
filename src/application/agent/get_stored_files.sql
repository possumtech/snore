-- PREP: get_stored_files
SELECT key
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'file'
	AND state != 'ignore'
	AND turn = 0
	AND state != 'symbols'
ORDER BY key;
