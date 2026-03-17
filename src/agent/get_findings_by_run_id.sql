-- PREP: get_findings_by_run_id
SELECT 'diff' as category, id, type, file_path as file, patch, status, turn_id
FROM findings_diffs
WHERE run_id = :run_id
UNION ALL
SELECT 'command' as category, id, type, NULL as file, command as patch, status, turn_id
FROM findings_commands
WHERE run_id = :run_id;