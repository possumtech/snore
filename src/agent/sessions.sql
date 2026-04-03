-- PREP: upsert_project
INSERT INTO projects (name, project_root, config_path)
VALUES (:name, :project_root, :config_path)
ON CONFLICT (name) DO UPDATE SET
	project_root = COALESCE(excluded.project_root, projects.project_root)
	, config_path = COALESCE(excluded.config_path, projects.config_path)
RETURNING id;

-- PREP: get_project_by_id
SELECT id, name, project_root, config_path, created_at
FROM projects
WHERE id = :id;

-- PREP: get_project_by_name
SELECT id, name, project_root, config_path, created_at
FROM projects
WHERE name = :name;

-- PREP: upsert_model
INSERT INTO models (alias, actual, context_length)
VALUES (:alias, :actual, :context_length)
ON CONFLICT (alias) DO UPDATE SET
	actual = excluded.actual
	, context_length = COALESCE(excluded.context_length, models.context_length)
RETURNING id;

-- PREP: get_model_by_alias
SELECT id, alias, actual, context_length
FROM models
WHERE alias = :alias;

-- PREP: get_models
SELECT id, alias, actual, context_length
FROM models
ORDER BY alias;

-- PREP: update_model_context_length
UPDATE models SET context_length = :context_length WHERE alias = :alias;

-- PREP: delete_model
DELETE FROM models WHERE alias = :alias;

-- PREP: purge_old_runs
DELETE FROM runs
WHERE
	status IN ('completed', 'aborted')
	AND created_at < datetime('now', '-' || :retention_days || ' days');
