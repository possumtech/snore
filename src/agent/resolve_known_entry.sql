-- PREP: resolve_known_entry
UPDATE known_entries
SET state = :state
	, value = :value
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND key = :key;
