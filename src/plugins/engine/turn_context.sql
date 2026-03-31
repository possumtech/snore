-- PREP: clear_turn_context
DELETE FROM turn_context
WHERE run_id = :run_id AND turn = :turn;

-- PREP: materialize_turn_context
INSERT INTO turn_context (
	run_id, turn, ordinal, path, bucket, content, tokens, meta
)
SELECT
	run_id
	, :turn
	, ordinal
	, path
	, bucket
	, content
	, tokens
	, meta
FROM v_model_context
WHERE run_id = :run_id;

-- PREP: insert_turn_context
INSERT INTO turn_context (
	run_id, turn, ordinal, path, bucket, content, tokens, meta
)
VALUES (
	:run_id, :turn, :ordinal, :path, :bucket, :content, :tokens, :meta
);

-- PREP: get_turn_context
SELECT ordinal, path, bucket, content, tokens, meta
FROM turn_context
WHERE run_id = :run_id AND turn = :turn
ORDER BY ordinal;

-- PREP: get_turn_budget
SELECT COALESCE(SUM(tokens), 0) AS total
FROM turn_context
WHERE run_id = :run_id AND turn = :turn;

-- PREP: get_turn_distribution
SELECT
	CASE
		WHEN bucket IN ('system', 'continuation', 'prompt') THEN 'system'
		WHEN bucket IN ('file', 'file:symbols') THEN 'files'
		WHEN bucket IN ('file:path', 'stored') THEN 'keys'
		WHEN bucket = 'known' THEN 'known'
		WHEN bucket IN ('result', 'unknown') THEN 'history'
		ELSE 'system'
	END AS bucket,
	COALESCE(SUM(tokens), 0) AS tokens,
	COUNT(*) AS entries
FROM turn_context
WHERE run_id = :run_id AND turn = :turn
GROUP BY 1
ORDER BY 1;
