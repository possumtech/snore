-- PREP: get_results
SELECT key, state, value, meta
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'result'
	AND state != 'proposed'
	AND key NOT LIKE '/:system/%'
	AND key NOT LIKE '/:user/%'
	AND key NOT LIKE '/:reasoning/%'
	AND key NOT LIKE '/:prompt/%'
ORDER BY id;
