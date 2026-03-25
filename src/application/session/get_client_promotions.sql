-- PREP: get_client_promotions
SELECT path, constraint_type
FROM client_promotions
WHERE project_id = :project_id;
