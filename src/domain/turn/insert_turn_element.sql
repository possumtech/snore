-- PREP: insert_turn_element
INSERT INTO turn_elements (
	turn_id,
	parent_id,
	tag_name,
	content,
	attributes,
	sequence
) VALUES (
	:turn_id,
	:parent_id,
	:tag_name,
	:content,
	:attributes,
	:sequence
) RETURNING id;
