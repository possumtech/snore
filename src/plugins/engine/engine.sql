-- PREP: get_promoted_entries
SELECT
	ke.path, ke.scheme, ke.state, ke.outcome, ke.visibility, ke.turn
	, ke.tokens, ke.refs
FROM known_entries AS ke
JOIN schemes AS s ON s.name = COALESCE(ke.scheme, 'file')
WHERE
	ke.run_id = :run_id
	AND ke.visibility IN ('visible', 'summarized')
	AND s.model_visible = 1
ORDER BY ke.turn, ke.refs, ke.tokens DESC;


