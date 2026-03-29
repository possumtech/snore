-- PREP: get_latest_prompt
SELECT key, value
FROM known_entries
WHERE run_id = :run_id
	AND key LIKE '/:prompt/%'
ORDER BY id DESC
LIMIT 1;
