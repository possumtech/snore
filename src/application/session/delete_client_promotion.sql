-- PREP: delete_client_promotion
DELETE FROM client_promotions
WHERE project_id = :project_id AND path GLOB :pattern;
