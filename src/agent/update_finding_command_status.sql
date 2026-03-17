-- PREP: update_finding_command_status
UPDATE findings_commands
SET status = :status
WHERE id = :id;