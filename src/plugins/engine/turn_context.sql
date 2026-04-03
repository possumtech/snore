-- PREP: clear_turn_context
DELETE FROM turn_context
WHERE run_id = :run_id AND turn = :turn;

-- PREP: get_model_context
SELECT
	ordinal, path, scheme, fidelity, state, body, tokens, attributes, category
FROM v_model_context
WHERE run_id = :run_id
ORDER BY ordinal;

-- PREP: materialize_turn_context
INSERT INTO turn_context (
	run_id, turn, ordinal, path, fidelity, state, body, tokens, attributes, category
)
SELECT
	run_id
	, :turn
	, ordinal
	, path
	, fidelity
	, state
	, body
	, tokens
	, attributes
	, category
FROM v_model_context
WHERE run_id = :run_id;

-- PREP: insert_turn_context
INSERT INTO turn_context (
	run_id, turn, ordinal, path, fidelity, state, body, tokens, attributes, category
)
VALUES (
	:run_id, :turn, :ordinal, :path, :fidelity, :state, :body, :tokens, :attributes, :category
);

-- PREP: get_turn_context
SELECT ordinal, path, scheme, fidelity, state, body, tokens, attributes, category
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
		WHEN 'file' THEN 'files'
		WHEN 'file_symbols' THEN 'files'
		WHEN 'file_index' THEN 'keys'
		WHEN 'known' THEN 'known'
		WHEN 'known_index' THEN 'keys'
		WHEN 'unknown' THEN 'history'
		WHEN 'result' THEN 'history'
		WHEN 'prompt' THEN 'system'
		WHEN 'system' THEN 'system'
		ELSE 'system'
	END AS bucket,
	COALESCE(SUM(tokens), 0) AS tokens,
	COUNT(*) AS entries
FROM turn_context
WHERE run_id = :run_id AND turn = :turn
GROUP BY 1
ORDER BY 1;
