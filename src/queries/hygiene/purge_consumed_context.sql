-- EXEC: purge_consumed_context
-- Delete pending_context entries that have been consumed by a turn.
DELETE FROM pending_context
WHERE consumed_by_turn_id IS NOT NULL;
