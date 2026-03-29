-- PREP: get_next_run_alias
SELECT
	COALESCE(
		MAX(CAST(SUBSTR(alias, LENGTH(:prefix) + 1) AS INTEGER))
		, 0
	) + 1 AS next_seq
FROM runs
WHERE
	alias LIKE :prefix || '%'
	AND SUBSTR(alias, LENGTH(:prefix) + 1) GLOB '[0-9]*';
