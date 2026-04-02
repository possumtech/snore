-- INIT: create_v_model_context
CREATE VIEW IF NOT EXISTS v_model_context AS
WITH
classified AS (
	SELECT
		ke.run_id
		, ke.id
		, ke.path
		, ke.value
		, ke.scheme
		, ke.state
		, ke.turn
		, ke.meta
		, ke.tokens AS tokens_full
		, CASE
			-- Proposed entries hidden until resolved
			WHEN ke.state = 'proposed' THEN NULL
			-- Audit schemes (model_visible = 0) hidden
			WHEN s.model_visible = 0 THEN NULL
			-- State IS fidelity for visible entries
			WHEN ke.state IN ('full', 'summary', 'index') THEN ke.state
			-- Stored entries hidden (retrievable via <read>)
			WHEN ke.state = 'stored' THEN NULL
			-- Result/structural states are visible at full fidelity
			WHEN ke.state IN ('pass', 'error', 'warn', 'pattern', 'read', 'info', 'summary') THEN 'full'
			ELSE NULL
		END AS fidelity
		, CASE
			WHEN ke.scheme IN ('ask', 'act', 'progress')
				THEN ROW_NUMBER() OVER (
					PARTITION BY ke.run_id, ke.scheme
					ORDER BY ke.id DESC
				)
			ELSE 1
		END AS prompt_rank
	FROM known_entries AS ke
	JOIN schemes AS s ON s.name = COALESCE(ke.scheme, 'file')
	WHERE ke.state NOT IN ('proposed')
),
projected AS (
	SELECT
		run_id
		, id
		, path
		, scheme
		, state
		, fidelity
		, CASE
			WHEN fidelity = 'full' THEN value
			WHEN fidelity = 'summary' THEN COALESCE(json_extract(meta, '$.symbols'), value)
			ELSE ''
		END AS content
		, CASE
			WHEN scheme IS NULL AND fidelity = 'full'
				THEN json_object(
					'constraint', json_extract(meta, '$.constraint')
					, 'tokens_full', tokens_full
				)
			WHEN scheme IN ('http', 'https') AND fidelity = 'full'
				THEN json_object(
					'constraint', json_extract(meta, '$.constraint')
					, 'tokens_full', tokens_full
				)
			WHEN
				scheme IS NOT NULL
				AND fidelity = 'full'
				AND scheme NOT IN (
					'known', 'unknown', 'ask', 'act', 'progress', 'http', 'https'
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
			WHEN scheme IS NULL AND state = 'full' THEN 'file'
			WHEN scheme IS NULL AND state = 'summary' THEN 'file_summary'
			WHEN scheme IS NULL AND state = 'index' THEN 'file_index'
			WHEN scheme IS NULL THEN 'file_index'
			WHEN scheme IN ('http', 'https') AND state = 'full' THEN 'file'
			WHEN scheme IN ('http', 'https') AND state = 'summary' THEN 'file_summary'
			WHEN scheme IN ('http', 'https') THEN 'file_index'
			WHEN scheme = 'known' AND state = 'full' THEN 'known'
			WHEN scheme = 'known' THEN 'known_index'
			WHEN scheme = 'unknown' THEN 'unknown'
			WHEN scheme IN ('ask', 'act', 'progress') THEN 'prompt'
			WHEN scheme = 'summary' THEN 'structural'
			WHEN scheme = 'update' THEN 'structural'
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
				WHEN 'file_summary' THEN 4
				WHEN 'file' THEN 5
				WHEN 'result' THEN 6
				WHEN 'structural' THEN 7
				WHEN 'unknown' THEN 8
				WHEN 'prompt' THEN 9
				ELSE 10
			END
			, id
	) AS ordinal
	, countTokens(content) AS tokens
FROM projected;
