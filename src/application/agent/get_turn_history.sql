-- PREP: get_turn_history
SELECT
	turn_id,
	role,
	content
FROM v_turn_history
WHERE run_id = :run_id
ORDER BY sequence ASC, msg_index ASC;
