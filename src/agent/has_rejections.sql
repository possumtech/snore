-- PREP: has_rejections
SELECT COUNT(*) AS count
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'result'
	AND state = 'warn';
