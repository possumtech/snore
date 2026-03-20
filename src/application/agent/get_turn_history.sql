-- PREP: get_turn_history
-- Retrieves the deduplicated history of user and assistant messages for a run
SELECT
	role,
	content,
	MAX(sequence_number) as max_seq
FROM v_turn_history
WHERE run_id = :run_id
GROUP BY role, content
ORDER BY max_seq ASC;
