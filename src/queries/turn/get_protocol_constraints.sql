-- PREP: get_protocol_constraints
SELECT required_tags, allowed_tags
FROM protocol_constraints
WHERE type = :type AND has_unknowns = :has_unknowns;
