-- PREP: insert_finding_diff
INSERT INTO findings_diffs (
	run_id
	, turn_id
	, type
	, file_path
	, patch
) VALUES (
	:run_id
	, :turn_id
	, :type
	, :file_path
	, :patch
)
RETURNING id;