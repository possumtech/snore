-- PREP: rename_run
UPDATE runs
SET alias = :new_alias
WHERE id = :id OR alias = :old_alias;
