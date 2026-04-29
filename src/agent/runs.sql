-- PREP: create_run
INSERT INTO runs (
	project_id
	, parent_run_id
	, model
	, alias
	, temperature
	, persona
	, context_limit
)
VALUES (
	:project_id
	, :parent_run_id
	, :model
	, :alias
	, :temperature
	, :persona
	, :context_limit
)
RETURNING id;

-- PREP: get_run_by_alias
SELECT
	id, project_id, parent_run_id, model, status, alias
	, temperature, persona, context_limit, next_turn, next_loop, created_at
FROM runs
WHERE alias = :alias;

-- PREP: get_run_by_id
SELECT
	id, project_id, parent_run_id, model, status, alias
	, temperature, persona, context_limit, next_turn, next_loop, created_at
FROM runs
WHERE id = :id;

-- PREP: get_runs_by_project
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
			AND ke.path LIKE 'log://turn_%/update/%'
		ORDER BY ke.id DESC
		LIMIT 1
	) AS summary
FROM runs AS r
WHERE r.project_id = :project_id
ORDER BY r.created_at DESC
LIMIT
	COALESCE(:limit, -1)
	OFFSET
	COALESCE(:offset, 0);

-- PREP: get_run_summary
-- Per-run aggregation across all turns. LEFT JOIN: a run with zero
-- recorded turns (e.g. signal abort before first turn) returns 0s,
-- not NULL.
SELECT
	r.model AS model
	, COUNT(t.id) AS turns
	, COALESCE(SUM(t.cost), 0) AS cost
	, COALESCE(SUM(t.prompt_tokens), 0) AS prompt_tokens
	, COALESCE(SUM(t.cached_tokens), 0) AS cached_tokens
	, COALESCE(SUM(t.completion_tokens), 0) AS completion_tokens
	, COALESCE(SUM(t.reasoning_tokens), 0) AS reasoning_tokens
	, COALESCE(SUM(t.total_tokens), 0) AS total_tokens
FROM runs AS r
LEFT JOIN turns AS t ON t.run_id = r.id
WHERE r.id = :id
GROUP BY r.id;

-- PREP: rename_run
UPDATE runs
SET alias = :new_alias
WHERE id = :id AND alias = :old_alias;

-- PREP: update_run_status
UPDATE runs SET status = :status WHERE id = :id;

-- PREP: update_run_config
UPDATE runs SET
	temperature = COALESCE(:temperature, temperature)
	, persona = COALESCE(:persona, persona)
	, context_limit = COALESCE(:context_limit, context_limit)
	, model = COALESCE(:model, model)
WHERE id = :id;

-- PREP: next_turn
UPDATE runs
SET next_turn = next_turn + 1
WHERE id = :run_id
RETURNING next_turn - 1 AS turn;

-- PREP: fork_known_entries
-- Cheap fork: copy only view rows. Entries stay shared between parent
-- and child. Child's subsequent writes diverge via upsert into a new
-- run-scoped entry.
INSERT INTO run_views (
	run_id, entry_id, loop_id, turn, state, outcome, visibility
	, write_count, refs
)
SELECT
	:new_run_id, entry_id, NULL, turn, state, outcome, visibility
	, write_count, refs
FROM run_views
WHERE run_id = :parent_run_id;

-- PREP: archive_prior_prompt_artifacts
-- Multi-prompt sessions accumulate artifacts from prior prompt cycles
-- (consumed prompts, their per-turn logs). These pollute the validator's
-- prior-prompts check on subsequent Deployment landings. Archive all
-- prior prompt:// entries and prior-turn log:// entries when a new
-- prompt arrives. Knowns/unknowns/file entries are untouched — they
-- carry persistent knowledge across cycles. The loop_id IS NULL clause
-- catches forked-in views from a parent run (per fork_known_entries),
-- which represent prior cycles' artifacts inherited into a clean child.
UPDATE run_views
SET visibility = 'archived'
WHERE run_id = :run_id
	AND visibility != 'archived'
	AND (turn < :current_turn OR loop_id IS NULL)
	AND entry_id IN (
		SELECT id FROM entries
		WHERE scheme IN ('prompt', 'log')
	);

-- PREP: get_active_runs
SELECT r.id
FROM runs AS r
WHERE
	r.project_id = :project_id
	AND r.status IN (100, 102, 202);

-- PREP: get_latest_run
SELECT r.id
FROM runs AS r
WHERE r.project_id = :project_id
ORDER BY r.created_at DESC
LIMIT 1;

-- PREP: get_all_runs
SELECT r.id
FROM runs AS r
WHERE r.project_id = :project_id;

-- PREP: abort_stuck_runs
UPDATE runs
SET status = 499
WHERE status IN (100, 102);
