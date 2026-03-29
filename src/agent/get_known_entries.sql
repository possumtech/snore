-- PREP: get_known_entries
SELECT key, domain, state, value, turn, hash, meta
FROM known_entries
WHERE run_id = :run_id
ORDER BY key;
