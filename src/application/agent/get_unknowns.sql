-- PREP: get_unknowns
SELECT key, value
FROM known_entries
WHERE run_id = :run_id
	AND key LIKE '/:unknown/%'
ORDER BY id;
