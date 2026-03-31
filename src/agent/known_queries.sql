-- PREP: get_known_entries
SELECT path, scheme, state, value, turn, hash, meta
FROM known_entries
WHERE run_id = :run_id
ORDER BY path;

-- PREP: get_active_known
SELECT path, value
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'known'
	AND turn > 0
ORDER BY path;

-- PREP: get_stored_known
SELECT path
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'known'
	AND turn = 0
ORDER BY path;

-- PREP: get_stored_files
SELECT path
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme IS NULL
	AND state != 'ignore'
	AND turn = 0
	AND state != 'symbols'
ORDER BY path;

-- PREP: get_symbol_files
SELECT path, value, meta
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme IS NULL
	AND state = 'symbols'
ORDER BY path;

-- PREP: get_full_files
SELECT path, state, value, tokens
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme IS NULL
	AND state != 'ignore'
	AND state != 'symbols'
	AND turn > 0
ORDER BY path;

-- PREP: get_results
SELECT path, state, value, meta
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme IS NOT NULL
	AND state != 'proposed'
	AND scheme NOT IN ('system', 'user', 'reasoning', 'prompt', 'known', 'unknown')
ORDER BY id;

-- PREP: get_unknowns
SELECT path, value
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'unknown'
ORDER BY id;

-- PREP: get_latest_prompt
SELECT path, value
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'prompt'
ORDER BY id DESC
LIMIT 1;

-- PREP: get_turn_audit
SELECT path, scheme, state, turn, value, meta
FROM known_entries
WHERE
	run_id = :run_id
	AND turn = :turn
ORDER BY id;
