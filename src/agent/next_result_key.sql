-- PREP: next_result_key
UPDATE runs
SET next_result_seq = next_result_seq + 1
WHERE id = :run_id
RETURNING next_result_seq - 1 AS seq;
