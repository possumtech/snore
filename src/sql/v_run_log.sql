-- INIT: create_v_run_log
CREATE VIEW IF NOT EXISTS v_run_log AS
SELECT
	ke.run_id
	, ke.path
	, ke.value
	, ke.state AS status
	, COALESCE(ke.scheme, ke.state) AS tool
	, COALESCE(
		json_extract(ke.meta, '$.command')
		, json_extract(ke.meta, '$.file')
		, json_extract(ke.meta, '$.path')
		, json_extract(ke.meta, '$.question')
		, ''
	) AS target
FROM known_entries AS ke
JOIN schemes AS s ON s.name = COALESCE(ke.scheme, 'file')
WHERE
	ke.scheme IS NOT NULL
	AND ke.state != 'proposed'
	AND s.category NOT IN ('knowledge', 'file')
	AND ke.scheme NOT IN ('system', 'reasoning', 'model', 'content')
ORDER BY ke.id;
