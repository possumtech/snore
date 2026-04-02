-- PREP: enqueue_prompt
INSERT INTO prompt_queue (run_id, session_id, mode, model, prompt, config)
VALUES (:run_id, :session_id, :mode, :model, :prompt, :config)
RETURNING id;

-- PREP: claim_next_prompt
UPDATE prompt_queue
SET status = 'active'
WHERE
	id = (
		SELECT
			id
		FROM prompt_queue
		WHERE run_id = :run_id AND status = 'pending'
		ORDER BY id
		LIMIT 1
	)
RETURNING id, run_id, session_id, mode, model, prompt, config;

-- PREP: complete_prompt
UPDATE prompt_queue
SET status = 'completed', result = :result
WHERE id = :id;

-- PREP: abort_active_prompt
UPDATE prompt_queue
SET status = 'aborted'
WHERE run_id = :run_id AND status = 'active';

-- PREP: get_pending_prompts
SELECT id, mode, model, prompt, status, created_at
FROM prompt_queue
WHERE run_id = :run_id AND status IN ('pending', 'active')
ORDER BY id;

-- PREP: reset_active_prompts
UPDATE prompt_queue
SET status = 'pending'
WHERE status = 'active';
