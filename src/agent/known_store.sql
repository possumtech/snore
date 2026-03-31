-- PREP: upsert_known_entry
INSERT INTO known_entries (
	run_id, turn, path, value, scheme, state, hash, meta
	, tokens, updated_at
)
VALUES (
	:run_id, :turn, :path, :value, :scheme, :state, :hash, :meta
	, length(:value) / 4
	, COALESCE(:updated_at, CURRENT_TIMESTAMP)
)
ON CONFLICT (run_id, path) DO UPDATE SET
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
WHERE run_id = :run_id AND path = :path;

-- PREP: get_stale_tokens
SELECT path, value
FROM known_entries
WHERE
	run_id = :run_id
	AND turn = :turn;

-- PREP: delete_known_entry
DELETE FROM known_entries
WHERE run_id = :run_id AND path = :path;

-- PREP: delete_file_entries_by_pattern
DELETE FROM known_entries
WHERE run_id = :run_id AND glorp(:pattern, path) AND scheme IS NULL;

-- PREP: resolve_known_entry
UPDATE known_entries
SET
	state = :state
	, value = :value
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND path = :path;

-- PREP: set_file_state
UPDATE known_entries
SET
	state = :state
	, turn = CASE WHEN :state = 'ignore' THEN 0 ELSE turn END
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND glorp(:pattern, path) AND scheme IS NULL;

-- PREP: promote_path
UPDATE known_entries
SET
	turn = :turn
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND path = :path;

-- PREP: demote_path
UPDATE known_entries
SET
	turn = 0
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND path = :path;

-- PREP: get_entry_value
SELECT value
FROM known_entries
WHERE run_id = :run_id AND path = :path;

-- PREP: get_entry_state
SELECT state, scheme, turn
FROM known_entries
WHERE run_id = :run_id AND path = :path;

-- PREP: get_file_states_by_pattern
SELECT path, state, turn
FROM known_entries
WHERE run_id = :run_id AND glorp(:pattern, path) AND scheme IS NULL
ORDER BY path;

-- PREP: get_entry_meta
SELECT meta
FROM known_entries
WHERE run_id = :run_id AND path = :path;

-- PREP: promote_by_pattern
UPDATE known_entries
SET
	turn = :turn
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND glorp(:path, path)
	AND (:value IS NULL OR glorp(:value, value));

-- PREP: demote_by_pattern
UPDATE known_entries
SET
	turn = 0
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND glorp(:path, path)
	AND (:value IS NULL OR glorp(:value, value));

-- PREP: get_entries_by_pattern
SELECT path, value, scheme, state, tokens, meta
FROM known_entries
WHERE
	run_id = :run_id
	AND glorp(:path, path)
	AND (:value IS NULL OR glorp(:value, value))
ORDER BY path;

-- PREP: delete_entries_by_pattern
DELETE FROM known_entries
WHERE
	run_id = :run_id
	AND glorp(:path, path)
	AND (:value IS NULL OR glorp(:value, value));

-- PREP: update_value_by_pattern
UPDATE known_entries
SET
	value = :new_value
	, tokens = length(:new_value) / 4
	, write_count = write_count + 1
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND glorp(:path, path)
	AND (:value IS NULL OR glorp(:value, value));
