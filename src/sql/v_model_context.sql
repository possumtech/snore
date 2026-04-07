-- INIT: create_v_model_context
CREATE VIEW IF NOT EXISTS v_model_context AS
WITH
visible AS (
	SELECT
		ke.run_id
		, ke.id
		, ke.path
		, ke.body
		, ke.scheme
		, ke.status
		, ke.fidelity
		, ke.turn
		, ke.updated_at
		, ke.attributes
		, ke.tokens AS tokens_full
		, CASE
			-- Stored entries not in context
			WHEN ke.fidelity = 'stored' THEN NULL
			-- 202 Accepted (proposed) hidden until resolved
			WHEN ke.status = 202 THEN NULL
			-- Audit schemes (model_visible = 0) hidden
			WHEN s.model_visible = 0 THEN NULL
			-- Everything else visible at its fidelity
			ELSE ke.fidelity
		END AS visible_fidelity
	FROM known_entries AS ke
	JOIN schemes AS s ON s.name = COALESCE(ke.scheme, 'file')
),
projected AS (
	SELECT
		run_id
		, id
		, path
		, scheme
		, status
		, visible_fidelity AS fidelity
		, turn
		, updated_at
		, attributes
		, CASE
			WHEN visible_fidelity IN ('full', 'summary') THEN body
			ELSE ''
		END AS body
		, CASE
			WHEN scheme IS NULL AND visible_fidelity IN ('full', 'summary') THEN 'file'
			WHEN scheme IS NULL THEN 'file_index'
			WHEN scheme IN ('http', 'https') AND visible_fidelity IN ('full', 'summary') THEN 'file'
			WHEN scheme IN ('http', 'https') THEN 'file_index'
			WHEN scheme IN ('known', 'skill') AND visible_fidelity = 'full' THEN 'known'
			WHEN scheme IN ('known', 'skill') THEN 'known_index'
			WHEN scheme = 'unknown' THEN 'unknown'
			WHEN scheme IN ('ask', 'act', 'progress') THEN 'prompt'
			WHEN scheme = 'summarize' THEN 'structural'
			WHEN scheme = 'update' THEN 'structural'
			WHEN scheme = 'tool' THEN 'tool'
			ELSE 'result'
		END AS category
	FROM visible
	WHERE visible_fidelity IS NOT NULL
)
SELECT
	run_id
	, path
	, scheme
	, fidelity
	, status
	, body
	, attributes
	, category
	, turn
	, ROW_NUMBER() OVER (
		PARTITION BY run_id
		ORDER BY
			CASE category
				WHEN 'tool' THEN 1
				WHEN 'known' THEN 2
				WHEN 'known_index' THEN 2
				WHEN 'file_index' THEN 2
				WHEN 'file' THEN 2
				WHEN 'result' THEN 3
				WHEN 'structural' THEN 4
				WHEN 'unknown' THEN 5
				WHEN 'prompt' THEN 6
				ELSE 6
			END
			, CASE scheme WHEN 'skill' THEN 0 ELSE 1 END
			, CASE fidelity
				WHEN 'index' THEN 0
				WHEN 'summary' THEN 1
				ELSE 2
			END
			, turn
			, updated_at
			, id
	) AS ordinal
	, countTokens(body) AS tokens
FROM projected;
