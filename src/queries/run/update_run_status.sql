-- PREP: update_run_status
UPDATE runs
SET
	status = :status
WHERE
	id = :id;