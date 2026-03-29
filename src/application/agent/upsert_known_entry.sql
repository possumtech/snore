-- PREP: upsert_known_entry
INSERT INTO known_entries (run_id, turn_id, key, value, domain, state, meta)
VALUES (:run_id, :turn_id, :key, :value, :domain, :state, :meta)
ON CONFLICT (run_id, key) DO UPDATE SET
	value = excluded.value
	, state = excluded.state
	, meta = COALESCE(excluded.meta, known_entries.meta)
	, turn_id = excluded.turn_id
	, write_count = known_entries.write_count + 1
	, updated_at = CURRENT_TIMESTAMP;
