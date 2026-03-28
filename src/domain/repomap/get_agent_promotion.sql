-- PREP: get_agent_promotion
SELECT id
FROM file_promotions
WHERE
	file_id = :file_id
	AND source = 'agent'
	AND run_id = :run_id;
