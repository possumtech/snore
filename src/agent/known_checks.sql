-- PREP: count_unknowns
SELECT COUNT(*) AS count
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'unknown';

-- PREP: get_unknown_values
SELECT body
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'unknown';

-- PREP: get_unresolved
SELECT path, body, attributes, turn
FROM known_entries
WHERE
	run_id = :run_id
	AND state = 'proposed';

-- PREP: has_rejections
-- Any failed entry in this loop counts as a rejection. Callers use
-- this to mark the turn as having errors. Specific failure categories
-- live in run_views.outcome (permission:, overflow:, validation:, ...).
SELECT COUNT(*) AS count
FROM known_entries
WHERE
	run_id = :run_id
	AND loop_id = :loop_id
	AND state = 'failed';

-- PREP: has_accepted_actions
SELECT COUNT(*) AS count
FROM known_entries
WHERE
	run_id = :run_id
	AND state = 'resolved'
	AND scheme IN ('set', 'sh', 'rm', 'mv', 'cp');

-- PREP: get_file_entries
SELECT path, state, outcome, fidelity, hash, updated_at
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme IS NULL;

