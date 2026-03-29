-- PREP: upsert_known_entry
INSERT INTO known_entries (run_id, turn_id, key, value, domain, state, target, tool_call_id)
VALUES (:run_id, :turn_id, :key, :value, :domain, :state, :target, :tool_call_id)
ON CONFLICT (run_id, key) DO UPDATE SET
	value = excluded.value
	, state = excluded.state
	, target = excluded.target
	, tool_call_id = excluded.tool_call_id
	, turn_id = excluded.turn_id
	, write_count = known_entries.write_count + 1
	, updated_at = CURRENT_TIMESTAMP;
