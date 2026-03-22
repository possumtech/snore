-- PREP: get_ranked_repo_map
-- Ranks files based on direct attention, dependencies, and project depth.
SELECT
	f.id,
	f.path,
	f.visibility,
	f.size,
	f.symbol_tokens,
	f.is_buffered,
	f.is_retained,
	f.last_attention_turn,
	(
		SELECT COUNT(*)
		FROM repo_map_references AS r
		JOIN repo_map_tags AS t ON r.symbol_name = t.name
		JOIN repo_map_files AS f2 ON r.file_id = f2.id
		WHERE
			t.file_id = f.id
			AND f2.is_active = 1
			AND f2.id != f.id
	) * 2 + f.is_root AS heat
FROM repo_map_files AS f
WHERE f.project_id = :project_id
ORDER BY
	f.is_active DESC,
	heat DESC,
	f.path ASC;
