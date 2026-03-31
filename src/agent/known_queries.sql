-- PREP: get_known_entries
SELECT path, scheme, state, value, turn, hash, meta
FROM known_entries
WHERE run_id = :run_id
ORDER BY path;

-- PREP: get_results
SELECT tool, target, status, path, value
FROM v_run_log
WHERE run_id = :run_id;

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

-- PREP: get_reasoning
SELECT path, value, turn
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'reasoning'
ORDER BY id;

-- PREP: get_latest_user_prompt
SELECT value
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'user'
ORDER BY id DESC
LIMIT 1;

-- PREP: get_latest_summary
SELECT value
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'summary'
ORDER BY id DESC
LIMIT 1;

-- PREP: get_history
SELECT path, state AS status, value, meta, turn
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme IS NOT NULL
	AND scheme NOT IN ('known', 'unknown', 'system', 'reasoning', 'content')
ORDER BY id;

-- PREP: get_content
SELECT path, value, turn
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'content'
ORDER BY id;
