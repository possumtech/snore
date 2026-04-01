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
	AND scheme IN ('ask', 'act')
ORDER BY id DESC
LIMIT 1;

-- PREP: get_latest_prompt
SELECT path, scheme, value, meta
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'prompt'
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
SELECT ke.path, ke.state AS status, ke.value, ke.meta, ke.turn
FROM known_entries AS ke
JOIN schemes AS s ON s.name = COALESCE(ke.scheme, 'file')
WHERE
	ke.run_id = :run_id
	AND ke.scheme IS NOT NULL
	AND s.category NOT IN ('knowledge', 'audit')
ORDER BY ke.id;

-- PREP: get_content
SELECT path, value, turn
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'content'
ORDER BY id;
