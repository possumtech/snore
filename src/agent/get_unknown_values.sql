-- PREP: get_unknown_values
SELECT value
FROM known_entries
WHERE run_id = :run_id
	AND key LIKE '/:unknown/%';
