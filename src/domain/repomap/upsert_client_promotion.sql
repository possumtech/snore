-- PREP: upsert_client_promotion
INSERT INTO file_promotions (file_id, source, constraint_type)
VALUES (:file_id, 'client', :constraint_type)
ON CONFLICT (file_id, source) DO UPDATE SET
	constraint_type = EXCLUDED.constraint_type;
