-- PREP: get_known_entries
SELECT
	path, scheme, state, outcome, fidelity, body, turn, hash
	, attributes, tokens, scope
FROM known_entries
WHERE run_id = :run_id
ORDER BY path;

-- PREP: get_results
SELECT tool, state, outcome, path, body, turn, attributes
FROM v_run_log
WHERE run_id = :run_id;

-- PREP: get_unknowns
SELECT path, body
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'unknown'
ORDER BY id;

-- PREP: get_turn_audit
SELECT path, scheme, state, outcome, fidelity, turn, body, attributes
FROM known_entries
WHERE
	run_id = :run_id
	AND turn = :turn
ORDER BY id;

-- PREP: get_reasoning
SELECT path, body, turn
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'reasoning'
ORDER BY id;

-- PREP: get_latest_user_prompt
SELECT body
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme IN ('ask', 'act')
	AND body != ''
ORDER BY id DESC
LIMIT 1;

-- PREP: get_latest_prompt
SELECT path, scheme, body, attributes
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'prompt'
ORDER BY id DESC
LIMIT 1;

-- PREP: get_latest_summary
SELECT body
FROM known_entries
WHERE
	run_id = :run_id
	AND loop_id = :loop_id
	AND scheme = 'update'
ORDER BY id DESC
LIMIT 1;

-- get_history retired — use get_results (v_run_log) for both run/state and getRun.

-- PREP: get_content
SELECT path, body, turn
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'content'
ORDER BY id;
