-- PREP: has_accepted_actions
SELECT COUNT(*) AS count
FROM known_entries
WHERE run_id = :run_id
	AND domain = 'result'
	AND state = 'pass'
	AND (key LIKE '/:edit/%' OR key LIKE '/:run/%' OR key LIKE '/:delete/%');
