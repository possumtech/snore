-- INIT: create_v_model_context
CREATE VIEW IF NOT EXISTS v_model_context AS
WITH
classified AS (
	SELECT
		run_id
		, id
		, path
		, value
		, scheme
		, state
		, turn
		, meta
		, tokens AS tokens_full
		, bucketOf(scheme, state, turn) AS bucket
		, CASE
			WHEN scheme = 'prompt'
				THEN ROW_NUMBER() OVER (
					PARTITION BY run_id, scheme
					ORDER BY id DESC
				)
			ELSE 1
		END AS prompt_rank
	FROM known_entries
	WHERE state NOT IN ('proposed', 'ignore')
),
projected AS (
	SELECT
		run_id
		, id
		, path
		, bucket
		, CASE bucket
			WHEN 'known' THEN value
			WHEN 'stored' THEN ''
			WHEN 'file:path' THEN ''
			WHEN 'file:symbols'
				THEN COALESCE(json_extract(meta, '$.symbols'), '')
			WHEN 'file' THEN value
			WHEN 'unknown' THEN value
			WHEN 'prompt' THEN value
			WHEN 'result'
				THEN CASE
					WHEN state = 'summary' THEN value
					WHEN scheme IN ('env', 'run', 'ask_user') THEN value
					ELSE ''
				END
			ELSE ''
		END AS content
		, CASE bucket
			WHEN 'file'
				THEN json_object(
					'state'
					, CASE state
						WHEN 'readonly' THEN 'file:readonly'
						WHEN 'active' THEN 'file:active'
						ELSE 'file'
					END
					, 'tokens_full', tokens_full
				)
			WHEN 'result'
				THEN json_object(
					'tool', COALESCE(scheme, state)
					, 'target', COALESCE(
						json_extract(meta, '$.command')
						, json_extract(meta, '$.file')
						, json_extract(meta, '$.path')
						, json_extract(meta, '$.question')
						, ''
					)
					, 'state', state
				)
			ELSE NULL
		END AS meta
	FROM classified
	WHERE bucket IS NOT NULL AND prompt_rank = 1
)
SELECT
	run_id
	, path
	, bucket
	, content
	, meta
	, ROW_NUMBER() OVER (
		PARTITION BY run_id
		ORDER BY
			CASE bucket
				WHEN 'known' THEN 1
				WHEN 'stored' THEN 2
				WHEN 'file:path' THEN 3
				WHEN 'file:symbols' THEN 4
				WHEN 'file' THEN 5
				WHEN 'result' THEN 6
				WHEN 'unknown' THEN 7
				WHEN 'prompt' THEN 8
			END
			, id
	) AS ordinal
	, countTokens(content) AS tokens
FROM projected;
