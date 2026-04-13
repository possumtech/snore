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
		, ke.tokens
		, COALESCE(s.category, 'logging') AS category
		, CASE
			-- Archived entries not in context
			WHEN ke.fidelity = 'archive' THEN NULL
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
		-- Category comes from schemes table — plugins declare it via registerScheme().
		, category
		, tokens
		, CASE
			WHEN visible_fidelity IN ('full', 'summary') THEN body
			ELSE ''
		END AS body
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
				WHEN 'data' THEN 2
				WHEN 'logging' THEN 3
				WHEN 'unknown' THEN 4
				WHEN 'prompt' THEN 5
				ELSE 5
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
