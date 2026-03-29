-- PREP: get_file_entries
SELECT key, state, hash
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'file';
