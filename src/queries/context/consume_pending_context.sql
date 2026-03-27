-- PREP: consume_pending_context
UPDATE pending_context
SET consumed_by_turn_id = :turn_id
WHERE id = :id;
