-- PREP: create_run
INSERT INTO runs (
	session_id
	, parent_run_id
	, config
	, alias
)
VALUES (
	:session_id
	, :parent_run_id
	, :config
	, :alias
)
RETURNING id;

-- PREP: get_run_by_alias
SELECT id, session_id, parent_run_id, status, config, alias, next_turn, created_at
FROM runs
WHERE alias = :alias;

-- PREP: get_run_by_id
SELECT id, session_id, parent_run_id, status, config, alias, next_turn, created_at
FROM runs
WHERE id = :id;

-- PREP: get_runs_by_session
SELECT
	r.alias
	, r.status
	, r.created_at
	, r.next_turn - 1 AS turn
	, (
		SELECT ke.body
		FROM known_entries AS ke
		WHERE
			ke.run_id = r.id
			AND ke.scheme = 'summarize'
		ORDER BY ke.id DESC
		LIMIT 1
	) AS summary
FROM runs AS r
WHERE r.session_id = :session_id
ORDER BY r.created_at DESC;

-- PREP: rename_run
UPDATE runs
SET alias = :new_alias
WHERE id = :id AND alias = :old_alias;

-- PREP: update_run_status
UPDATE runs SET status = :status WHERE id = :id;

-- PREP: next_turn
UPDATE runs
SET next_turn = next_turn + 1
WHERE id = :run_id
RETURNING next_turn - 1 AS turn;

-- PREP: fork_known_entries
INSERT INTO known_entries (
	run_id, turn, path, body, state
	, hash, attributes, tokens, tokens_full, refs, write_count
)
SELECT
	:new_run_id, turn, path, body, state
	, hash, attributes, tokens, tokens_full, refs, write_count
FROM known_entries
WHERE run_id = :parent_run_id;

-- PREP: get_active_runs
SELECT r.id
FROM runs AS r
JOIN sessions AS s ON r.session_id = s.id
WHERE
	s.project_id = :project_id
	AND r.status IN ('queued', 'running', 'proposed');

-- PREP: get_latest_run
SELECT r.id
FROM runs AS r
JOIN sessions AS s ON r.session_id = s.id
WHERE s.project_id = :project_id
ORDER BY r.created_at DESC
LIMIT 1;

-- PREP: get_all_runs
SELECT r.id
FROM runs AS r
JOIN sessions AS s ON r.session_id = s.id
WHERE s.project_id = :project_id;

-- PREP: abort_stuck_runs
UPDATE runs
SET status = 'aborted'
WHERE status IN ('running', 'queued');
