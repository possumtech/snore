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
	AND scheme IN ('edit', 'run', 'delete');

-- PREP: get_file_entries
SELECT path, state, hash, updated_at
FROM known_entries
WHERE
	run_id = :run_id
	AND scheme IS NULL;

-- PREP: get_context_distribution
SELECT
	CASE
		WHEN scheme IN ('system', 'prompt') THEN 'system'
		WHEN scheme IS NULL AND turn > 0 AND state != 'symbols' THEN 'files'
		WHEN scheme IS NULL THEN 'keys'
		WHEN scheme = 'known' AND turn > 0 THEN 'known'
		WHEN scheme = 'known' AND turn = 0 THEN 'keys'
		WHEN scheme = 'unknown' THEN 'history'
		WHEN scheme IS NOT NULL AND state NOT IN ('proposed', 'info') THEN 'history'
		ELSE 'system'
	END AS bucket,
	COALESCE(SUM(tokens), 0) AS tokens,
	COUNT(*) AS entries
FROM known_entries
WHERE
	run_id = :run_id
	AND (scheme IS NULL OR scheme NOT IN ('reasoning', 'user', 'retry'))
GROUP BY bucket
ORDER BY bucket;
