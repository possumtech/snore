-- PREP: get_known_entries
SELECT path, scheme, state, value, turn, hash, meta
FROM known_entries
WHERE run_id = :run_id
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

-- PREP: get_turn_audit
SELECT path, scheme, state, turn, value, meta
FROM known_entries
WHERE
	run_id = :run_id
	AND turn = :turn
ORDER BY id;
