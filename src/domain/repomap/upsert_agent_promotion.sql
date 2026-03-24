-- PREP: upsert_agent_promotion
INSERT INTO file_promotions (file_id, source, last_attention_turn)
VALUES (:file_id, 'agent', :turn_seq)
ON CONFLICT (file_id, source) DO UPDATE SET
	last_attention_turn = EXCLUDED.last_attention_turn;
