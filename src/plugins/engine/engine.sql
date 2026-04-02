-- PREP: get_promoted_entries
SELECT ke.path, ke.scheme, ke.state, ke.turn, ke.tokens, ke.refs, s.tier
FROM known_entries AS ke
JOIN schemes AS s ON s.name = COALESCE(ke.scheme, 'file')
WHERE
	ke.run_id = :run_id
	AND ke.state IN ('full', 'summary')
	AND s.tier > 0
	AND s.model_visible = 1
ORDER BY s.tier, ke.turn, ke.refs, ke.tokens DESC;

-- PREP: get_promoted_token_total
SELECT COALESCE(SUM(ke.tokens), 0) AS total
FROM known_entries AS ke
JOIN schemes AS s ON s.name = COALESCE(ke.scheme, 'file')
WHERE
	ke.run_id = :run_id
	AND ke.state IN ('full', 'summary')
	AND s.tier > 0
	AND s.model_visible = 1;
