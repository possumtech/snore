-- PREP: get_unresolved_findings
SELECT category, id, type, file, patch, status, turn_id, config
FROM v_unresolved_findings
WHERE run_id = :run_id;
