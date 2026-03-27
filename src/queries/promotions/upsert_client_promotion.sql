-- PREP: upsert_client_promotion
INSERT INTO client_promotions (project_id, path, constraint_type)
VALUES (:project_id, :path, :constraint_type)
ON CONFLICT (project_id, path) DO UPDATE SET
	constraint_type = EXCLUDED.constraint_type;
