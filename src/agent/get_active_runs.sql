-- PREP: get_active_runs
SELECT r.id
FROM runs AS r
JOIN sessions AS s ON r.session_id = s.id
WHERE s.project_id = :project_id
	AND r.status IN ('queued', 'running', 'proposed');
