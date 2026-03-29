-- PREP: get_entry_value
SELECT value
FROM known_entries
WHERE run_id = :run_id AND key = :key;
