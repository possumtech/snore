-- PREP: upsert_agent_promotion
INSERT INTO file_promotions (file_id, source, run_id, last_attention_turn)
VALUES (:file_id, 'agent', :run_id, :turn_seq)
ON CONFLICT (file_id, source, run_id) WHERE run_id IS NOT NULL DO UPDATE SET
	last_attention_turn = EXCLUDED.last_attention_turn;
