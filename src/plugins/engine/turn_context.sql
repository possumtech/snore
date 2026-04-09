-- PREP: clear_turn_context
DELETE FROM turn_context
WHERE run_id = :run_id AND turn = :turn;

-- PREP: get_model_context
SELECT
	ordinal, path, scheme, fidelity, status, body
	, tokens, attributes, category, turn
FROM v_model_context
WHERE run_id = :run_id
ORDER BY ordinal;

-- PREP: insert_turn_context
INSERT INTO turn_context (
	run_id, loop_id, turn, ordinal, path, fidelity, status
	, body, tokens, attributes, category, source_turn
)
VALUES (
	:run_id, :loop_id, :turn, :ordinal, :path, :fidelity
	, :status, :body, :tokens
	, COALESCE(:attributes, '{}'), :category, :source_turn
);

-- PREP: get_turn_context
SELECT
	ordinal, path, scheme, fidelity, status, body
	, tokens, attributes, category, source_turn
FROM turn_context
WHERE run_id = :run_id AND turn = :turn
ORDER BY ordinal;

-- PREP: get_turn_budget
SELECT COALESCE(SUM(tokens), 0) AS total
FROM turn_context
WHERE run_id = :run_id AND turn = :turn;

-- PREP: get_turn_distribution
SELECT
	CASE category
		WHEN 'data' THEN 'data'
		WHEN 'logging' THEN 'logging'
		WHEN 'unknown' THEN 'unknown'
		WHEN 'prompt' THEN 'prompt'
		ELSE 'system'
	END AS bucket,
	COALESCE(SUM(tokens), 0) AS tokens,
	COUNT(*) AS entries
FROM turn_context
WHERE run_id = :run_id AND turn = :turn
GROUP BY 1
ORDER BY 1;
