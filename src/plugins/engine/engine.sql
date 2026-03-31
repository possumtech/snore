-- PREP: get_promoted_entries
SELECT path, scheme, state, turn, tokens, refs, tierOf(scheme, state) AS tier
FROM known_entries
WHERE
	run_id = :run_id
	AND turn > 0
	AND state NOT IN ('proposed', 'ignore', 'info', 'summary')
	AND (scheme IS NULL OR scheme NOT IN (
		'system', 'user', 'reasoning', 'prompt', 'inject'
	))
ORDER BY tier, turn, refs, tokens DESC;

-- PREP: get_promoted_token_total
SELECT COALESCE(SUM(tokens), 0) AS total
FROM known_entries
WHERE
	run_id = :run_id
	AND turn > 0
	AND state NOT IN ('proposed', 'ignore', 'info', 'summary')
	AND (scheme IS NULL OR scheme NOT IN (
		'system', 'user', 'reasoning', 'prompt', 'inject'
	));
