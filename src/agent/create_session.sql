-- PREP: create_session
INSERT INTO sessions (id, project_id, client_id)
VALUES (:id, :project_id, :client_id);
