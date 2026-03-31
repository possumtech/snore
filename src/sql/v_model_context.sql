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
		, fidelityOf(scheme, state, turn) AS fidelity
		, CASE
			WHEN scheme IN ('user', 'prompt')
				THEN ROW_NUMBER() OVER (
					PARTITION BY run_id, scheme
					ORDER BY id DESC
				)
			ELSE 1
		END AS prompt_rank
	FROM known_entries
	WHERE state NOT IN ('proposed')
),
projected AS (
	SELECT
		run_id
		, id
		, path
		, scheme
		, state
		, fidelity
		, CASE fidelity
			WHEN 'full'
				THEN CASE
					WHEN scheme IS NULL THEN value
					WHEN scheme = 'known' THEN value
					WHEN scheme = 'unknown' THEN value
					WHEN scheme IN ('user', 'prompt') THEN value
					WHEN scheme IN ('http', 'https') THEN value
					WHEN state = 'summary' THEN value
					WHEN scheme IN ('env', 'run', 'ask_user') THEN value
					ELSE ''
				END
			WHEN 'summary'
				THEN COALESCE(json_extract(meta, '$.symbols'), '')
			ELSE ''
		END AS content
		, CASE
			WHEN scheme IS NULL AND fidelity = 'full'
				THEN json_object(
					'constraint'
					, json_extract(meta, '$.constraint')
					, 'tokens_full', tokens_full
				)
			WHEN
				scheme IS NOT NULL
				AND fidelity = 'full'
				AND scheme NOT IN (
					'known', 'unknown', 'user', 'prompt', 'http', 'https'
				)
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
		, CASE
			WHEN scheme IS NULL AND fidelity = 'full' THEN 'file'
			WHEN scheme IS NULL AND fidelity = 'summary' THEN 'file_symbols'
			WHEN scheme IS NULL THEN 'file_index'
			WHEN scheme IN ('http', 'https') AND fidelity = 'full' THEN 'file'
			WHEN scheme IN ('http', 'https') THEN 'file_index'
			WHEN scheme = 'known' AND fidelity = 'full' THEN 'known'
			WHEN scheme = 'known' THEN 'known_index'
			WHEN scheme = 'unknown' THEN 'unknown'
			WHEN scheme IN ('user', 'prompt') THEN 'prompt'
			ELSE 'result'
		END AS category
	FROM classified
	WHERE fidelity IS NOT NULL AND prompt_rank = 1
)
SELECT
	run_id
	, path
	, scheme
	, fidelity
	, content
	, meta
	, category
	, ROW_NUMBER() OVER (
		PARTITION BY run_id
		ORDER BY
			CASE category
				WHEN 'known' THEN 1
				WHEN 'known_index' THEN 2
				WHEN 'file_index' THEN 3
				WHEN 'file_symbols' THEN 4
				WHEN 'file' THEN 5
				WHEN 'result' THEN 6
				WHEN 'unknown' THEN 7
				WHEN 'prompt' THEN 8
				ELSE 9
			END
			, id
	) AS ordinal
	, countTokens(content) AS tokens
FROM projected;
