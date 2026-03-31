-- PREP: upsert_known_entry
INSERT INTO known_entries (
	run_id, turn, key, value, domain, state, hash, meta
	, tokens, updated_at
)
VALUES (
	:run_id, :turn, :key, :value, :domain, :state, :hash, :meta
	, length(:value) / 4
	, COALESCE(:updated_at, CURRENT_TIMESTAMP)
)
ON CONFLICT (run_id, key) DO UPDATE SET
	value = excluded.value
	, state = excluded.state
	, hash = COALESCE(excluded.hash, known_entries.hash)
	, meta = COALESCE(excluded.meta, known_entries.meta)
	, turn = excluded.turn
	, tokens = length(excluded.value) / 4
	, write_count = known_entries.write_count + 1
	, updated_at = COALESCE(excluded.updated_at, CURRENT_TIMESTAMP);

-- PREP: recount_tokens
UPDATE known_entries
SET tokens = :tokens
WHERE run_id = :run_id AND key = :key;

-- PREP: get_stale_tokens
SELECT key, value
FROM known_entries
WHERE
	run_id = :run_id
	AND turn = :turn;

-- PREP: delete_known_entry
DELETE FROM known_entries
WHERE run_id = :run_id AND key = :key;

-- PREP: delete_file_entries_by_pattern
DELETE FROM known_entries
WHERE run_id = :run_id AND glorp(:pattern, key) AND domain = 'file';

-- PREP: resolve_known_entry
UPDATE known_entries
SET
	state = :state
	, value = :value
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND key = :key;

-- PREP: set_file_state
UPDATE known_entries
SET
	state = :state
	, turn = CASE WHEN :state = 'ignore' THEN 0 ELSE turn END
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND glorp(:pattern, key) AND domain = 'file';

-- PREP: promote_key
UPDATE known_entries
SET
	turn = :turn
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND key = :key;

-- PREP: demote_key
UPDATE known_entries
SET
	turn = 0
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND key = :key;

-- PREP: get_entry_value
SELECT value
FROM known_entries
WHERE run_id = :run_id AND key = :key;

-- PREP: get_entry_state
SELECT state, domain, turn
FROM known_entries
WHERE run_id = :run_id AND key = :key;

-- PREP: get_file_states_by_pattern
SELECT key, state, turn
FROM known_entries
WHERE run_id = :run_id AND glorp(:pattern, key) AND domain = 'file'
ORDER BY key;

-- PREP: get_entry_meta
SELECT meta
FROM known_entries
WHERE run_id = :run_id AND key = :key;
