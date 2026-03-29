-- PREP: upsert_known_entry
INSERT INTO known_entries (run_id, turn, key, value, domain, state, hash, meta, tokens)
VALUES (:run_id, :turn, :key, :value, :domain, :state, :hash, :meta, length(:value) / 4)
ON CONFLICT (run_id, key) DO UPDATE SET
	value = excluded.value
	, state = excluded.state
	, hash = COALESCE(excluded.hash, known_entries.hash)
	, meta = COALESCE(excluded.meta, known_entries.meta)
	, turn = excluded.turn
	, tokens = length(excluded.value) / 4
	, write_count = known_entries.write_count + 1
	, updated_at = CURRENT_TIMESTAMP;

-- PREP: delete_known_entry
DELETE FROM known_entries
WHERE run_id = :run_id AND key = :key;

-- PREP: resolve_known_entry
UPDATE known_entries
SET state = :state
	, value = :value
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND key = :key;

-- PREP: promote_key
UPDATE known_entries
SET turn = :turn
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND key = :key;

-- PREP: demote_key
UPDATE known_entries
SET turn = 0
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND key = :key;

-- PREP: get_entry_value
SELECT value
FROM known_entries
WHERE run_id = :run_id AND key = :key;
