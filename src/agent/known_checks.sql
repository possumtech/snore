-- PREP: count_unknowns
SELECT COUNT(*) AS count
FROM known_entries
WHERE run_id = :run_id
	AND key LIKE '/:unknown/%';

-- PREP: get_unknown_values
SELECT value
FROM known_entries
WHERE run_id = :run_id
	AND key LIKE '/:unknown/%';

-- PREP: get_unresolved
SELECT key, value, meta, turn
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'result'
	AND state = 'proposed';

-- PREP: has_rejections
SELECT COUNT(*) AS count
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'result'
	AND state = 'warn';

-- PREP: has_accepted_actions
SELECT COUNT(*) AS count
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'result'
	AND state = 'pass'
	AND (key LIKE '/:edit/%' OR key LIKE '/:run/%' OR key LIKE '/:delete/%');

-- PREP: get_file_entries
SELECT key, state, hash
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'file';
