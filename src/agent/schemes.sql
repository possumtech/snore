-- PREP: upsert_scheme
INSERT INTO schemes (name, model_visible, category, default_scope, writable_by)
VALUES (
	:name
	, :model_visible
	, :category
	, COALESCE(:default_scope, 'run')
	, COALESCE(:writable_by, '["model","plugin"]')
)
ON CONFLICT (name) DO UPDATE SET
	model_visible = excluded.model_visible
	, category = excluded.category
	, default_scope = excluded.default_scope
	, writable_by = excluded.writable_by;

-- PREP: get_all_schemes
SELECT name, model_visible, category, default_scope, writable_by FROM schemes;
