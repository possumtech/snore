-- PREP: create_job
INSERT INTO jobs (id, session_id, parent_job_id, type, status, config)
VALUES (:id, :session_id, :parent_job_id, :type, 'queued', :config)
RETURNING id;
