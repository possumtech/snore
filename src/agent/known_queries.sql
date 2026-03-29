-- PREP: get_known_entries
SELECT key, domain, state, value, turn, hash, meta
FROM known_entries
WHERE run_id = :run_id
ORDER BY key;

-- PREP: get_active_known
SELECT key, value
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'known'
	AND key LIKE '/:known/%'
	AND turn > 0
ORDER BY key;

-- PREP: get_stored_known
SELECT key
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'known'
	AND key LIKE '/:known/%'
	AND turn = 0
ORDER BY key;

-- PREP: get_stored_files
SELECT key
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'file'
	AND state != 'ignore'
	AND turn = 0
	AND state != 'symbols'
ORDER BY key;

-- PREP: get_symbol_files
SELECT key, value, meta
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'file'
	AND state = 'symbols'
ORDER BY key;

-- PREP: get_full_files
SELECT key, state, value
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'file'
	AND state != 'ignore'
	AND state != 'symbols'
	AND turn > 0
ORDER BY key;

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

-- PREP: get_unknowns
SELECT key, value
FROM known_entries
WHERE run_id = :run_id
	AND key LIKE '/:unknown/%'
ORDER BY id;

-- PREP: get_latest_prompt
SELECT key, value
FROM known_entries
WHERE run_id = :run_id
	AND key LIKE '/:prompt/%'
ORDER BY id DESC
LIMIT 1;
