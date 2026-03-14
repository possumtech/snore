-- PREP: get_job_by_id
SELECT
	id
	, session_id
	, parent_job_id
	, type
	, status
	, config
	, created_at
FROM jobs
WHERE id = :id;
