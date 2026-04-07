-- PREP: enqueue_loop
INSERT INTO loops (run_id, sequence, mode, model, prompt, config)
VALUES (:run_id, :sequence, :mode, :model, :prompt, :config)
RETURNING id, sequence;

-- PREP: next_loop
UPDATE runs
SET next_loop = next_loop + 1
WHERE id = :run_id
RETURNING next_loop - 1 AS sequence;

-- PREP: claim_next_loop
UPDATE loops
SET status = 102
WHERE
	id = (
		SELECT
			id
		FROM loops
		WHERE run_id = :run_id AND status = 100
		ORDER BY id
		LIMIT 1
	)
RETURNING id, run_id, sequence, mode, model, prompt, config;

-- PREP: complete_loop
UPDATE loops
SET status = :status, result = :result
WHERE id = :id;

-- PREP: abort_active_loop
UPDATE loops
SET status = 499
WHERE run_id = :run_id AND status = 102;

-- PREP: get_pending_loops
SELECT id, sequence, mode, model, prompt, status, created_at
FROM loops
WHERE run_id = :run_id AND status IN (100, 102)
ORDER BY id;

-- PREP: reset_active_loops
UPDATE loops
SET status = 100
WHERE status = 102;

-- PREP: get_current_loop
SELECT id, sequence, mode, model, prompt, status
FROM loops
WHERE run_id = :run_id AND status = 102
LIMIT 1;

-- PREP: get_loop_by_id
SELECT id, run_id, sequence, mode, model, prompt, status, config
FROM loops
WHERE id = :id;

-- PREP: get_latest_completed_loop
SELECT id, sequence, mode, status
FROM loops
WHERE run_id = :run_id AND status IN (200, 500)
ORDER BY id DESC
LIMIT 1;
