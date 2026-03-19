-- PREP: update_finding_diff_status
UPDATE findings_diffs
SET status = :status
WHERE id = :id;