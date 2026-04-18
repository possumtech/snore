-- PREP: upsert_entry
-- Content-layer upsert. Returns entry id for the subsequent run_view write.
INSERT INTO entries (
	scope, path, body, attributes, hash, tokens, updated_at
)
VALUES (
	:scope, :path, :body, COALESCE(:attributes, '{}'), :hash
	, countTokens(:body), CURRENT_TIMESTAMP
)
ON CONFLICT (scope, path) DO UPDATE SET
	body = excluded.body
	, attributes = COALESCE(excluded.attributes, entries.attributes)
	, hash = COALESCE(excluded.hash, entries.hash)
	, tokens = countTokens(excluded.body)
	, updated_at = CURRENT_TIMESTAMP
RETURNING id;

-- PREP: upsert_run_view
-- View-layer upsert. Called after upsert_entry with the returned entry id.
INSERT INTO run_views (
	run_id, entry_id, loop_id, turn, status, fidelity, updated_at
)
VALUES (
	:run_id, :entry_id, :loop_id, :turn, :status, :fidelity, CURRENT_TIMESTAMP
)
ON CONFLICT (run_id, entry_id) DO UPDATE SET
	loop_id = excluded.loop_id
	, turn = excluded.turn
	, status = excluded.status
	, fidelity = excluded.fidelity
	, write_count = run_views.write_count + 1
	, updated_at = CURRENT_TIMESTAMP;

-- Helper fragment: "the entry this run's view references at this path".
-- Every UPDATE/DELETE resolves its target this way so the logic is
-- correct whether the entry lives in the run's own scope or a shared one.

-- PREP: recount_tokens
UPDATE entries
SET tokens = :tokens
WHERE id = (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id AND e.path = :path
	LIMIT 1
);

-- PREP: append_entry_body
-- Streaming entry body growth. Appends a chunk to the existing body and
-- recomputes tokens. Content change, so targets entries.
UPDATE entries
SET
	body = body || :chunk
	, tokens = countTokens(body || :chunk)
	, updated_at = CURRENT_TIMESTAMP
WHERE id = (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id AND e.path = :path
	LIMIT 1
);

-- PREP: get_stale_tokens
SELECT e.path, e.body
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id
WHERE rv.run_id = :run_id AND rv.turn = :turn;

-- PREP: delete_known_entry
-- Removes the view only. Entry is left for future GC; may be shared.
DELETE FROM run_views
WHERE run_id = :run_id AND entry_id = (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id AND e.path = :path
	LIMIT 1
);

-- PREP: delete_file_entries_by_pattern
DELETE FROM run_views
WHERE run_id = :run_id AND entry_id IN (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id
		AND hedmatch(:pattern, e.path)
		AND e.scheme IS NULL
);

-- PREP: resolve_known_entry_view
UPDATE run_views
SET
	status = :status
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND entry_id = (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id AND e.path = :path
	LIMIT 1
);

-- PREP: resolve_known_entry_body
UPDATE entries
SET
	body = :body
	, tokens = countTokens(:body)
	, updated_at = CURRENT_TIMESTAMP
WHERE id = (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id AND e.path = :path
	LIMIT 1
);

-- PREP: set_file_fidelity
UPDATE run_views
SET
	fidelity = :fidelity
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND entry_id IN (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id
		AND hedmatch(:pattern, e.path)
		AND e.scheme IS NULL
);

-- PREP: promote_path
UPDATE run_views
SET
	fidelity = 'promoted'
	, status = 200
	, turn = :turn
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND entry_id = (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id AND e.path = :path
	LIMIT 1
);

-- PREP: demote_path
UPDATE run_views
SET
	fidelity = 'archived'
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND entry_id = (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id AND e.path = :path
	LIMIT 1
);

-- PREP: set_fidelity
UPDATE run_views
SET
	fidelity = :fidelity
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND entry_id = (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id AND e.path = :path
	LIMIT 1
);

-- PREP: get_entry_body
SELECT e.body AS body
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id
WHERE rv.run_id = :run_id AND e.path = :path;

-- PREP: get_entry_state
SELECT rv.status, rv.fidelity, e.scheme, rv.turn
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id
WHERE rv.run_id = :run_id AND e.path = :path;

-- PREP: get_file_states_by_pattern
SELECT e.path, rv.status, rv.fidelity, rv.turn
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id
WHERE rv.run_id = :run_id
	AND hedmatch(:pattern, e.path)
	AND e.scheme IS NULL
ORDER BY e.path;

-- PREP: update_entry_attributes
UPDATE entries
SET
	attributes = json_patch(attributes, :attributes)
	, updated_at = CURRENT_TIMESTAMP
WHERE id = (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id AND e.path = :path
	LIMIT 1
);

-- PREP: get_entry_attributes
SELECT e.attributes AS attributes
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id
WHERE rv.run_id = :run_id AND e.path = :path;

-- PREP: promote_by_pattern
UPDATE run_views
SET
	fidelity = 'promoted'
	, status = 200
	, turn = :turn
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND entry_id IN (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id
		AND hedmatch(:path, e.path)
		AND (:body IS NULL OR hedsearch(:body, e.body))
);

-- PREP: demote_by_pattern
UPDATE run_views
SET
	fidelity = 'archived'
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND entry_id IN (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id
		AND hedmatch(:path, e.path)
		AND (:body IS NULL OR hedsearch(:body, e.body))
);

-- PREP: get_entries_by_pattern
SELECT
	e.path, e.body, e.scheme, rv.status, rv.fidelity, e.tokens, e.attributes
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id
WHERE rv.run_id = :run_id
	AND hedmatch(:path, e.path)
	AND (:body IS NULL OR hedsearch(:body, e.body))
ORDER BY e.path
LIMIT COALESCE(:limit, -1)
OFFSET COALESCE(:offset, 0);

-- PREP: delete_entries_by_pattern
DELETE FROM run_views
WHERE run_id = :run_id AND entry_id IN (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id
		AND hedmatch(:path, e.path)
		AND (:body IS NULL OR hedsearch(:body, e.body))
);

-- PREP: update_body_by_pattern
UPDATE entries
SET
	body = :new_body
	, tokens = countTokens(:new_body)
	, updated_at = CURRENT_TIMESTAMP
WHERE id IN (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id
		AND hedmatch(:path, e.path)
		AND (:body IS NULL OR hedsearch(:body, e.body))
);

-- PREP: bump_write_count_by_pattern
-- Companion to update_body_by_pattern. write_count lives on run_views.
UPDATE run_views
SET
	write_count = write_count + 1
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND entry_id IN (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id
		AND hedmatch(:path, e.path)
		AND (:body IS NULL OR hedsearch(:body, e.body))
);

-- PREP: get_turn_demotion_targets
-- Rows that demote_turn_entries is about to flip. Return shape
-- matches the old RETURNING (path, tokens) for caller compatibility.
SELECT e.path, e.tokens
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id
WHERE rv.run_id = :run_id
	AND rv.turn = :turn
	AND rv.fidelity = 'promoted'
	AND rv.status < 400;

-- PREP: demote_turn_entries
-- View-layer only — fidelity lives on run_views. Status untouched.
-- Call get_turn_demotion_targets first if you need the list of what
-- was demoted (required by budget plugin for the budget:// summary).
UPDATE run_views
SET
	fidelity = 'demoted'
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id
	AND turn = :turn
	AND fidelity = 'promoted'
	AND status < 400;
