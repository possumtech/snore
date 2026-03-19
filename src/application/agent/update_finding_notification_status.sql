-- PREP: update_finding_notification_status
UPDATE findings_notifications SET status = :status WHERE id = :id;
