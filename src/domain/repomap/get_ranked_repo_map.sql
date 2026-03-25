-- PREP: get_ranked_repo_map
SELECT
	f.id
	, f.path
	, f.size
	, f.symbol_tokens
	, cp.constraint_type AS client_constraint
	, ap.last_attention_turn
	, CASE WHEN ap.id IS NOT NULL THEN 1 ELSE 0 END AS has_agent_promotion
	, CASE WHEN ep.id IS NOT NULL THEN 1 ELSE 0 END AS has_editor_promotion
	, (cp.id IS NOT NULL OR ap.id IS NOT NULL OR ep.id IS NOT NULL) AS is_promoted
	, (
		SELECT COUNT(*)
		FROM repo_map_references AS r
		JOIN repo_map_tags AS t ON r.symbol_name = t.name
		JOIN repo_map_files AS f2 ON r.file_id = f2.id
		WHERE
			t.file_id = f.id
			AND f2.id != f.id
			AND (
				EXISTS (
					SELECT 1 FROM client_promotions
					WHERE project_id = f.project_id AND path = f2.path
				)
				OR EXISTS (
					SELECT 1
					FROM file_promotions
					WHERE file_id = f2.id AND source = 'agent' AND run_id = :run_id
				)
				OR EXISTS (
					SELECT 1 FROM file_promotions WHERE file_id = f2.id AND source = 'editor'
				)
			)
	) * 2 + f.is_root AS heat
FROM repo_map_files AS f
LEFT JOIN client_promotions AS cp ON f.project_id = cp.project_id AND f.path = cp.path
LEFT JOIN
	file_promotions AS ap
	ON f.id = ap.file_id AND ap.source = 'agent' AND ap.run_id = :run_id
LEFT JOIN file_promotions AS ep ON f.id = ep.file_id AND ep.source = 'editor'
WHERE f.project_id = :project_id
ORDER BY
	is_promoted DESC
	, heat DESC
	, f.path ASC;
