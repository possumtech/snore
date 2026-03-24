-- PREP: delete_agent_promotion
DELETE FROM file_promotions
WHERE file_id = :file_id AND source = 'agent';
