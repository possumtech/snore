-- EXEC: insert_finding_notification
INSERT INTO findings_notifications (run_id, turn_id, type, text, level, status, config, append)
VALUES (:run_id, :turn_id, :type, :text, :level, :status, :config, :append);
