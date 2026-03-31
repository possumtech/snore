-- PREP: upsert_file_constraint
INSERT INTO file_constraints (project_id, pattern, visibility)
VALUES (:project_id, :pattern, :visibility)
ON CONFLICT (project_id, pattern) DO UPDATE SET
	visibility = excluded.visibility;

-- PREP: delete_file_constraint
DELETE FROM file_constraints
WHERE project_id = :project_id AND pattern = :pattern;

-- PREP: get_file_constraints
SELECT pattern, visibility
FROM file_constraints
WHERE project_id = :project_id
ORDER BY pattern;
