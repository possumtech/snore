-- PREP: insert_repo_map_tag
INSERT INTO repo_map_tags (file_id, name, type, params, line, source)
VALUES (:file_id, :name, :type, :params, :line, :source);
