-- INIT: create_v_run_log
CREATE VIEW IF NOT EXISTS v_run_log AS
SELECT
	run_id
	, path
	, COALESCE(scheme, state) AS tool
	, COALESCE(
		json_extract(meta, '$.command')
		, json_extract(meta, '$.file')
		, json_extract(meta, '$.path')
		, json_extract(meta, '$.question')
		, ''
	) AS target
	, state AS status
	, CASE
		WHEN state = 'summary' THEN value
		WHEN scheme IN ('env', 'run', 'ask_user') THEN value
		ELSE ''
	END AS value
FROM known_entries
WHERE
	scheme IS NOT NULL
	AND state != 'proposed'
	AND scheme NOT IN ('system', 'user', 'reasoning', 'content', 'prompt', 'known', 'unknown')
ORDER BY id;
