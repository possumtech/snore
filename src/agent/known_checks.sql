-- PREP: count_unknowns
SELECT COUNT(*) AS count
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'unknown';

-- PREP: get_unknown_values
SELECT value
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme = 'unknown';

-- PREP: get_unresolved
SELECT path, value, meta, turn
FROM known_entries
WHERE
	run_id = :run_id
	AND state = 'proposed';

-- PREP: has_rejections
SELECT COUNT(*) AS count
FROM known_entries
WHERE
	run_id = :run_id
	AND state = 'warn';

-- PREP: has_accepted_actions
SELECT COUNT(*) AS count
FROM known_entries
WHERE
	run_id = :run_id
	AND state = 'pass'
	AND scheme IN ('edit', 'run', 'delete', 'move', 'copy');

-- PREP: get_file_entries
SELECT path, state, hash, updated_at
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme IS NULL;
