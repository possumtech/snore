-- PREP: insert_finding_command
INSERT INTO findings_commands (
	run_id
	, turn_id
	, type
	, command
) VALUES (
	:run_id
	, :turn_id
	, :type
	, :command
)
RETURNING id;