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
	AND status = 202;

-- PREP: has_rejections
SELECT COUNT(*) AS count
FROM known_entries
WHERE
	run_id = :run_id
	AND loop_id = :loop_id
	AND status = 403;

-- PREP: has_accepted_actions
SELECT COUNT(*) AS count
FROM known_entries
WHERE
	run_id = :run_id
	AND status = 200
	AND scheme IN ('set', 'sh', 'rm', 'mv', 'cp');

-- PREP: get_file_entries
SELECT path, status, fidelity, hash, updated_at
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme IS NULL;
