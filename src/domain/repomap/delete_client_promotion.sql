-- PREP: delete_client_promotion
DELETE FROM file_promotions
WHERE file_id = :file_id AND source = 'client';
