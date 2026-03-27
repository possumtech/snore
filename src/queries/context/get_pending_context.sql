-- PREP: get_pending_context
SELECT id, type, request, result, is_error
FROM pending_context
WHERE run_id = :run_id AND consumed_by_turn_id IS NULL
ORDER BY id ASC;
