-- PREP: get_findings_by_run_id
SELECT 'diff' as category, id, type, file_path as file, patch, status, turn_id, NULL as config
FROM findings_diffs
WHERE run_id = :run_id
UNION ALL
SELECT 'command' as category, id, type, NULL as file, command as patch, status, turn_id, NULL as config
FROM findings_commands
WHERE run_id = :run_id
UNION ALL
SELECT 'notification' as category, id, type, NULL as file, text as patch, status, turn_id, config
FROM findings_notifications
WHERE run_id = :run_id;
