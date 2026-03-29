-- PREP: get_symbol_files
SELECT key, value, meta
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'file'
	AND state = 'symbols'
ORDER BY key;
