-- PREP: get_catalog_age
SELECT MIN(fetched_at) AS oldest
FROM provider_models;
