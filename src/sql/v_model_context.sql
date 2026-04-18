-- INIT: create_v_model_context
CREATE VIEW IF NOT EXISTS v_model_context AS
WITH
visible AS (
	SELECT
		rv.run_id
		, rv.id
		, e.path
		, e.body
		, e.scheme
		, rv.state
		, rv.outcome
		, rv.fidelity
		, rv.turn
		, rv.updated_at
		, e.attributes
		, e.tokens
		, COALESCE(s.category, 'logging') AS category
		, CASE
			-- Archived entries not in context
			WHEN rv.fidelity = 'archived' THEN NULL
			-- Proposed entries hidden until the client resolves them
			WHEN rv.state = 'proposed' THEN NULL
			-- Audit schemes (model_visible = 0) hidden
			WHEN s.model_visible = 0 THEN NULL
			-- Everything else visible at its fidelity
			ELSE rv.fidelity
		END AS visible_fidelity
	FROM run_views AS rv
	JOIN entries AS e ON e.id = rv.entry_id
	JOIN schemes AS s ON s.name = COALESCE(e.scheme, 'file')
),
projected AS (
	SELECT
		run_id
		, id
		, path
		, scheme
		, state
		, outcome
		, visible_fidelity AS fidelity
		, turn
		, updated_at
		, attributes
		-- Category comes from schemes table — plugins declare it via registerScheme().
		, category
		, tokens
		, CASE
			WHEN visible_fidelity IN ('promoted', 'demoted') THEN body
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
	, state
	, outcome
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
				WHEN 'demoted' THEN 0
				ELSE 1
			END
			, turn
			, updated_at
			, id
	) AS ordinal
	, countTokens(body) AS tokens
FROM projected;
