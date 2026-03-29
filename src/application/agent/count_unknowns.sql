-- PREP: count_unknowns
SELECT COUNT(*) AS count
FROM known_entries
WHERE run_id = :run_id
	AND key LIKE '/:unknown/%';
