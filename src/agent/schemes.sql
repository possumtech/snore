-- PREP: upsert_scheme
INSERT OR REPLACE INTO schemes (name, model_visible, category)
VALUES (:name, :model_visible, :category);
