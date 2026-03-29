-- PREP: delete_known_entry
DELETE FROM known_entries
WHERE run_id = :run_id AND key = :key;
