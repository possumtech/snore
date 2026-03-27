-- PREP: insert_session_skill
INSERT OR IGNORE INTO session_skills (
	session_id
	, name
) VALUES (
	:session_id
	, :name
);