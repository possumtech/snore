-- PREP: get_active_known
SELECT key, value
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'known'
	AND key LIKE '/:known/%'
	AND turn > 0
ORDER BY key;
