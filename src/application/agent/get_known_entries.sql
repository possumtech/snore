-- PREP: get_known_entries
SELECT key, domain, state, value, target
FROM known_entries
WHERE run_id = :run_id
ORDER BY key;
