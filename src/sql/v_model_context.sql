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
		, rv.visibility
		, rv.turn
		, rv.updated_at
		, e.attributes
		, COALESCE(s.category, 'logging') AS category
		, CASE
			WHEN s.model_visible = 0 THEN NULL
			WHEN rv.visibility = 'archived' THEN NULL
			ELSE rv.visibility
		END AS effective_visibility
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
		, effective_visibility AS visibility
		, turn
		, updated_at
		, attributes
		-- Category comes from schemes table — plugins declare it via registerScheme().
		, category
		, body
	FROM visible
	WHERE effective_visibility IS NOT NULL
)
SELECT
	run_id
	, path
	, scheme
	, visibility
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
			, scheme
			, turn
			, updated_at
			, path
	) AS ordinal
FROM projected;
