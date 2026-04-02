-- PREP: upsert_known_entry
INSERT INTO known_entries (
	run_id, turn, path, value, state, hash, meta
	, tokens, tokens_full, updated_at
)
VALUES (
	:run_id, :turn, :path, :value, :state, :hash, :meta
	, countTokens(:value)
	, countTokens(:value)
	, COALESCE(:updated_at, CURRENT_TIMESTAMP)
)
ON CONFLICT (run_id, path) DO UPDATE SET
	value = excluded.value
	, state = excluded.state
	, hash = COALESCE(excluded.hash, known_entries.hash)
	, meta = COALESCE(excluded.meta, known_entries.meta)
	, turn = excluded.turn
	, tokens = countTokens(excluded.value)
	, tokens_full = countTokens(excluded.value)
	, write_count = known_entries.write_count + 1
	, updated_at = COALESCE(excluded.updated_at, CURRENT_TIMESTAMP);

-- PREP: recount_tokens
UPDATE known_entries
SET tokens = :tokens, tokens_full = :tokens
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
WHERE run_id = :run_id AND hedberg(:pattern, path) AND scheme IS NULL;

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
	, tokens = CASE
		WHEN :state = 'summary'
			THEN CASE
				WHEN
					json_valid(meta)
					AND json_extract(meta, '$.symbols') IS NOT NULL
					THEN countTokens(json_extract(meta, '$.symbols'))
				ELSE countTokens(path)
			END
		ELSE tokens_full
	END
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND hedberg(:pattern, path) AND scheme IS NULL;

-- PREP: promote_path
UPDATE known_entries
SET
	state = 'full'
	, turn = :turn
	, tokens = tokens_full
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND path = :path;

-- PREP: demote_path
UPDATE known_entries
SET
	state = 'stored'
	, tokens = 0
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
WHERE run_id = :run_id AND hedberg(:pattern, path) AND scheme IS NULL
ORDER BY path;

-- PREP: get_entry_meta
SELECT meta
FROM known_entries
WHERE run_id = :run_id AND path = :path;

-- PREP: promote_by_pattern
UPDATE known_entries
SET
	state = 'full'
	, turn = :turn
	, tokens = tokens_full
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND hedberg(:path, path)
	AND (:value IS NULL OR hedberg(:value, value));

-- PREP: demote_by_pattern
UPDATE known_entries
SET
	state = 'stored'
	, tokens = 0
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND hedberg(:path, path)
	AND (:value IS NULL OR hedberg(:value, value));

-- PREP: get_entries_by_pattern
SELECT path, value, scheme, state, tokens_full, meta
FROM known_entries
WHERE
	run_id = :run_id
	AND hedberg(:path, path)
	AND (:value IS NULL OR hedberg(:value, value))
ORDER BY path;

-- PREP: delete_entries_by_pattern
DELETE FROM known_entries
WHERE
	run_id = :run_id
	AND hedberg(:path, path)
	AND (:value IS NULL OR hedberg(:value, value));

-- PREP: update_value_by_pattern
UPDATE known_entries
SET
	value = :new_value
	, tokens = countTokens(:new_value)
	, tokens_full = countTokens(:new_value)
	, write_count = write_count + 1
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND hedberg(:path, path)
	AND (:value IS NULL OR hedberg(:value, value));
