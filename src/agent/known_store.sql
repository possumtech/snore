-- PREP: upsert_entry
-- Content-layer upsert. Returns entry id for the subsequent run_view write.
-- Null :attributes on UPDATE path means "don't touch existing attributes"
-- — so UPDATE reads :attributes directly, not excluded.attributes (which
-- would have been coerced to '{}' by the VALUES clause).
INSERT INTO entries (
	scope, path, body, attributes, hash, tokens, updated_at
)
VALUES (
	:scope, :path, :body, COALESCE(:attributes, '{}'), :hash
	, countTokens(:body), CURRENT_TIMESTAMP
)
ON CONFLICT (scope, path) DO UPDATE SET
	body = excluded.body
	, attributes = COALESCE(:attributes, entries.attributes)
	, hash = COALESCE(:hash, entries.hash)
	, tokens = countTokens(excluded.body)
	, updated_at = CURRENT_TIMESTAMP
RETURNING id;

-- PREP: upsert_run_view
-- View-layer upsert. Called after upsert_entry with the returned entry id.
INSERT INTO run_views (
	run_id, entry_id, loop_id, turn, state, outcome, visibility, updated_at
)
VALUES (
	:run_id, :entry_id, :loop_id, :turn, :state, :outcome, :visibility
	, CURRENT_TIMESTAMP
)
ON CONFLICT (run_id, entry_id) DO UPDATE SET
	loop_id = excluded.loop_id
	, turn = excluded.turn
	, state = excluded.state
	, outcome = excluded.outcome
	, visibility = excluded.visibility
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
	WHERE
		rv.run_id = :run_id
		AND hedmatch(:pattern, e.path)
		AND e.scheme IS NULL
);

-- PREP: resolve_known_entry_view
UPDATE run_views
SET
	state = :state
	, outcome = :outcome
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

-- PREP: set_file_visibility
UPDATE run_views
SET
	visibility = :visibility
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND entry_id IN (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE
		rv.run_id = :run_id
		AND hedmatch(:pattern, e.path)
		AND e.scheme IS NULL
);

-- PREP: promote_path
UPDATE run_views
SET
	visibility = 'visible'
	, state = 'resolved'
	, outcome = NULL
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
	visibility = 'archived'
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND entry_id = (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE rv.run_id = :run_id AND e.path = :path
	LIMIT 1
);

-- PREP: set_visibility
UPDATE run_views
SET
	visibility = :visibility
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
SELECT rv.state, rv.outcome, rv.visibility, e.scheme, rv.turn
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id
WHERE rv.run_id = :run_id AND e.path = :path;

-- PREP: get_file_states_by_pattern
SELECT e.path, rv.state, rv.outcome, rv.visibility, rv.turn
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id
WHERE
	rv.run_id = :run_id
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
	visibility = 'visible'
	, state = 'resolved'
	, outcome = NULL
	, turn = :turn
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND entry_id IN (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE
		rv.run_id = :run_id
		AND hedmatch(:path, e.path)
		AND (:body IS NULL OR hedsearch(:body, e.body))
);

-- PREP: demote_by_pattern
UPDATE run_views
SET
	visibility = 'archived'
	, updated_at = CURRENT_TIMESTAMP
WHERE run_id = :run_id AND entry_id IN (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE
		rv.run_id = :run_id
		AND hedmatch(:path, e.path)
		AND (:body IS NULL OR hedsearch(:body, e.body))
);

-- PREP: get_entries_by_pattern
SELECT
	e.path, e.body, e.scheme, rv.state, rv.outcome, rv.visibility
	, e.tokens, e.attributes
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id
WHERE
	rv.run_id = :run_id
	AND hedmatch(:path, e.path)
	AND (:body IS NULL OR hedsearch(:body, e.body))
ORDER BY e.path
LIMIT
	COALESCE(:limit, -1)
	OFFSET COALESCE(:offset, 0);

-- PREP: delete_entries_by_pattern
DELETE FROM run_views
WHERE run_id = :run_id AND entry_id IN (
	SELECT e.id FROM entries AS e
	JOIN run_views AS rv ON rv.entry_id = e.id
	WHERE
		rv.run_id = :run_id
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
	WHERE
		rv.run_id = :run_id
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
	WHERE
		rv.run_id = :run_id
		AND hedmatch(:path, e.path)
		AND (:body IS NULL OR hedsearch(:body, e.body))
);

-- PREP: get_turn_demotion_targets
-- Rows that demote_turn_entries is about to flip. Return shape
-- matches the old RETURNING (path, tokens) for caller compatibility.
-- State filter: skip failed/cancelled entries (they're already not
-- contributing visible context — demoting them would be misleading).
-- Scheme filter: skip known/unknown — these are the model's deliverables,
-- not housekeeping. Auto-demoting just-created knowns punishes the
-- correct Distill+Demote pattern.
SELECT e.path, e.tokens
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id
WHERE
	rv.run_id = :run_id
	AND rv.turn = :turn
	AND rv.visibility = 'visible'
	AND rv.state NOT IN ('failed', 'cancelled')
	AND e.scheme NOT IN ('known', 'unknown');

-- PREP: demote_turn_entries
-- View-layer only — visibility lives on run_views. State untouched.
-- Call get_turn_demotion_targets first if you need the list of what
-- was demoted (used by budget plugin for the overflow error body).
-- Scheme filter mirrors get_turn_demotion_targets — never demote the
-- model's deliverables (known/unknown) along with housekeeping.
UPDATE run_views
SET
	visibility = 'summarized'
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND turn = :turn
	AND visibility = 'visible'
	AND state NOT IN ('failed', 'cancelled')
	AND NOT EXISTS (
		SELECT 1 FROM entries AS e
		WHERE e.id = run_views.entry_id
			AND e.scheme IN ('known', 'unknown')
	);

-- PREP: get_run_visible_targets
-- All visible entries across the run, oldest promotion first. Used by
-- budget postDispatch as the fallback demotion set when this-turn
-- demotion yields nothing but the packet still overflows (promotions
-- from prior turns the model forgot to demote themselves).
SELECT e.path, e.tokens, rv.turn
FROM run_views AS rv
JOIN entries AS e ON e.id = rv.entry_id
WHERE
	rv.run_id = :run_id
	AND rv.visibility = 'visible'
	AND rv.state NOT IN ('failed', 'cancelled')
ORDER BY rv.turn, e.id;

-- PREP: demote_run_visible
-- Broad cross-turn demotion. Separate prep from demote_turn_entries
-- so the caller's intent (surgical this-turn vs fallback all-visible)
-- stays explicit.
UPDATE run_views
SET
	visibility = 'summarized'
	, updated_at = CURRENT_TIMESTAMP
WHERE
	run_id = :run_id
	AND visibility = 'visible'
	AND state NOT IN ('failed', 'cancelled');
