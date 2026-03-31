-- PREP: get_promoted_entries
SELECT path, scheme, state, turn, tokens, refs
FROM known_entries
WHERE
	run_id = :run_id
	AND turn > 0
	AND state NOT IN ('proposed', 'ignore', 'info', 'summary')
	AND scheme NOT IN ('system', 'user', 'reasoning', 'prompt', 'inject')
ORDER BY path;

-- PREP: get_promoted_token_total
SELECT COALESCE(SUM(tokens), 0) AS total
FROM known_entries
WHERE
	run_id = :run_id
	AND turn > 0
	AND state NOT IN ('proposed', 'ignore', 'info', 'summary')
	AND scheme NOT IN ('system', 'user', 'reasoning', 'prompt', 'inject');

-- PREP: downgrade_file_to_symbols
UPDATE known_entries
SET
	state = 'symbols'
	, tokens = CASE
		WHEN json_valid(meta) AND json_extract(meta, '$.symbols') IS NOT NULL
			THEN length(json_extract(meta, '$.symbols')) / 4
		ELSE 0
	END
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND path = :path AND scheme IS NULL;
