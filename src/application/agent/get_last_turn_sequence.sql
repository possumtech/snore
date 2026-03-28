-- PREP: get_last_turn_sequence
SELECT MAX(sequence) as last_seq, id as last_turn_id
FROM turns
WHERE run_id = :run_id;
