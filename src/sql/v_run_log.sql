-- INIT: create_v_run_log
CREATE VIEW IF NOT EXISTS v_run_log AS
SELECT
	ke.run_id
	, ke.path
	, ke.body
	, ke.status
	, COALESCE(ke.scheme, 'file') AS tool
	, COALESCE(
		json_extract(ke.attributes, '$.command')
		, json_extract(ke.attributes, '$.file')
		, json_extract(ke.attributes, '$.path')
		, json_extract(ke.attributes, '$.question')
		, ''
	) AS target
FROM known_entries AS ke
JOIN schemes AS s ON s.name = COALESCE(ke.scheme, 'file')
WHERE
	ke.scheme IS NOT NULL
	AND ke.status != 202
	AND s.category NOT IN ('knowledge', 'file')
	AND ke.scheme NOT IN ('system', 'reasoning', 'model', 'content')
ORDER BY ke.id;
