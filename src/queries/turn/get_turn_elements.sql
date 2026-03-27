-- PREP: get_turn_elements
-- Fetches the entire turn hierarchy, ordered by parent and sequence.
SELECT
	id,
	parent_id,
	tag_name,
	content,
	attributes,
	sequence
FROM turn_elements
WHERE turn_id = :turn_id
ORDER BY parent_id ASC, sequence ASC;
