-- PREP: upsert_known_entry
INSERT INTO known_entries (
	run_id, loop_id, turn, path, body, status, fidelity, hash
	, attributes, tokens, tokens_full, updated_at
)
VALUES (
	:run_id, :loop_id, :turn, :path, :body, :status, :fidelity, :hash
	, COALESCE(:attributes, '{}')
	, countTokens(:body)
	, countTokens(:body)
	, COALESCE(:updated_at, CURRENT_TIMESTAMP)
)
ON CONFLICT (run_id, path) DO UPDATE SET
	body = excluded.body
	, status = excluded.status
	, fidelity = excluded.fidelity
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
	status = :status
	, body = :body
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND path = :path;

-- PREP: set_file_fidelity
UPDATE known_entries
SET
	fidelity = :fidelity
	, tokens = CASE
		WHEN :fidelity = 'archive'
			THEN 0
		WHEN :fidelity = 'index'
			THEN 0
		WHEN :fidelity = 'summary'
			THEN COALESCE(
				countTokens(json_extract(attributes, '$.summary')),
				countTokens(substr(body, 1, 80))
			)
		ELSE tokens_full
	END
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND hedmatch(:pattern, path) AND scheme IS NULL;

-- PREP: promote_path
UPDATE known_entries
SET
	fidelity = 'full'
	, turn = :turn
	, tokens = tokens_full
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND path = :path;

-- PREP: demote_path
UPDATE known_entries
SET
	fidelity = 'archive'
	, tokens = 0
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND path = :path;

-- PREP: set_fidelity
UPDATE known_entries
SET
	fidelity = :fidelity
	, tokens = CASE
		WHEN :fidelity = 'archive'
			THEN 0
		WHEN :fidelity = 'index'
			THEN 0
		WHEN :fidelity = 'summary'
			THEN COALESCE(
				countTokens(json_extract(attributes, '$.summary')),
				countTokens(substr(body, 1, 80))
			)
		ELSE countTokens(body)
	END
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND path = :path;

-- PREP: get_entry_body
SELECT body
FROM known_entries
WHERE run_id = :run_id AND path = :path;

-- PREP: get_entry_state
SELECT status, fidelity, scheme, turn
FROM known_entries
WHERE run_id = :run_id AND path = :path;

-- PREP: get_file_states_by_pattern
SELECT path, status, fidelity, turn
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
	fidelity = 'full'
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
	fidelity = 'archive'
	, tokens = 0
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND hedmatch(:path, path)
	AND (:body IS NULL OR hedsearch(:body, body));

-- PREP: get_entries_by_pattern
SELECT path, body, scheme, status, fidelity, tokens_full, attributes
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

-- PREP: restore_summarized_prompts
-- Restore prompt entries demoted to summary by a recovery phase that was
-- interrupted (e.g. server crash). Safe to call unconditionally at loop
-- start: if the full prompt would overflow, Prompt Demotion handles it.
UPDATE known_entries
SET
	fidelity = 'full'
	, tokens = tokens_full
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND scheme = 'prompt' AND fidelity = 'summary';

-- PREP: demote_previous_loop_logging
-- Demote full logging entries from all other loops to summary.
-- Fires at loop start so <previous> entries are already compact.
UPDATE known_entries
SET
	fidelity = 'summary'
	, tokens = COALESCE(
		countTokens(json_extract(attributes, '$.summary'))
		, countTokens(substr(body, 1, 80))
	)
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND (loop_id IS NULL OR loop_id != :loop_id)
	AND fidelity = 'full'
	AND scheme IN (SELECT name FROM schemes WHERE category = 'logging');

-- PREP: demote_turn_entries
-- Demote all full entries from a turn to summary with 413 status.
-- No exceptions. Budget entries survive because onView renders full
-- body at summary fidelity.
UPDATE known_entries
SET
	fidelity = 'summary'
	, status = 413
	, tokens = COALESCE(
		countTokens(json_extract(attributes, '$.summary'))
		, countTokens(substr(body, 1, 80))
	)
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND turn = :turn
	AND fidelity = 'full'
	AND status < 400
RETURNING path;

-- PREP: demote_all_full
-- Batch-demote ALL full entries to summary. No exceptions.
-- Fires when pre-turn or LLM context overflow reaches AgentLoop.
UPDATE known_entries
SET
	fidelity = 'summary'
	, status = 413
	, tokens = COALESCE(
		countTokens(json_extract(attributes, '$.summary'))
		, countTokens(substr(body, 1, 80))
	)
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND fidelity = 'full'
	AND status < 400
RETURNING path;
