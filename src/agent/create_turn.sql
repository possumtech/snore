-- PREP: create_turn
INSERT INTO turns (run_id, sequence)
VALUES (:run_id, :sequence)
RETURNING id, sequence;
