-- PREP: upsert_known_entry
INSERT INTO known_entries (
	run_id, loop_id, turn, path, body, state, hash, attributes
	, tokens, tokens_full, updated_at
)
VALUES (
	:run_id, :loop_id, :turn, :path, :body, :state, :hash, COALESCE(:attributes, '{}')
	, countTokens(:body)
	, countTokens(:body)
	, COALESCE(:updated_at, CURRENT_TIMESTAMP)
)
ON CONFLICT (run_id, path) DO UPDATE SET
	body = excluded.body
	, state = excluded.state
	, hash = COALESCE(excluded.hash, known_entries.hash)
	, attributes = COALESCE(excluded.attributes, known_entries.attributes)
	, loop_id = excluded.loop_id
	, turn = excluded.turn
	, tokens = countTokens(excluded.body)
	, tokens_full = countTokens(excluded.body)
	, write_count = known_entries.write_count + 1
	, updated_at = COALESCE(excluded.updated_at, CURRENT_TIMESTAMP);

-- PREP: recount_tokens
UPDATE known_entries
SET tokens = :tokens, tokens_full = :tokens
WHERE run_id = :run_id AND path = :path;

-- PREP: get_stale_tokens
SELECT path, body
FROM known_entries
WHERE
	run_id = :run_id
	AND turn = :turn;

-- PREP: delete_known_entry
DELETE FROM known_entries
WHERE run_id = :run_id AND path = :path;

-- PREP: delete_file_entries_by_pattern
DELETE FROM known_entries
WHERE run_id = :run_id AND hedmatch(:pattern, path) AND scheme IS NULL;

-- PREP: resolve_known_entry
UPDATE known_entries
SET
	state = :state
	, body = :body
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND path = :path;

-- PREP: set_file_state
UPDATE known_entries
SET
	state = :state
	, tokens = CASE
		WHEN :state = 'summary' THEN countTokens(body)
		ELSE tokens_full
	END
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND hedmatch(:pattern, path) AND scheme IS NULL;

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

-- PREP: get_entry_body
SELECT body
FROM known_entries
WHERE run_id = :run_id AND path = :path;

-- PREP: get_entry_state
SELECT state, scheme, turn
FROM known_entries
WHERE run_id = :run_id AND path = :path;

-- PREP: get_file_states_by_pattern
SELECT path, state, turn
FROM known_entries
WHERE run_id = :run_id AND hedmatch(:pattern, path) AND scheme IS NULL
ORDER BY path;

-- PREP: update_entry_attributes
UPDATE known_entries
SET
	attributes = json_patch(attributes, :attributes)
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND path = :path;

-- PREP: get_entry_attributes
SELECT attributes
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
	AND hedmatch(:path, path)
	AND (:body IS NULL OR hedsearch(:body, body));

-- PREP: demote_by_pattern
UPDATE known_entries
SET
	state = 'stored'
	, tokens = 0
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND hedmatch(:path, path)
	AND (:body IS NULL OR hedsearch(:body, body));

-- PREP: get_entries_by_pattern
SELECT path, body, scheme, state, tokens_full, attributes
FROM known_entries
WHERE
	run_id = :run_id
	AND hedmatch(:path, path)
	AND (:body IS NULL OR hedsearch(:body, body))
ORDER BY path
LIMIT
	COALESCE(:limit, -1)
	OFFSET
	COALESCE(:offset, 0);

-- PREP: delete_entries_by_pattern
DELETE FROM known_entries
WHERE
	run_id = :run_id
	AND hedmatch(:path, path)
	AND (:body IS NULL OR hedsearch(:body, body));

-- PREP: update_body_by_pattern
UPDATE known_entries
SET
	body = :new_body
	, tokens = countTokens(:new_body)
	, tokens_full = countTokens(:new_body)
	, write_count = write_count + 1
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND hedmatch(:path, path)
	AND (:body IS NULL OR hedsearch(:body, body));
