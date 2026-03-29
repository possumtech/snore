-- PREP: promote_key
UPDATE known_entries
SET turn = :turn
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND key = :key;
