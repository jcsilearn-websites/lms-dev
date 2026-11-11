-- Step 9e: questions.current_version_id and question_versions.question_id point at each other. The first was declared
-- ON DELETE RESTRICT, which PostgreSQL checks at once even when the constraint is DEFERRABLE, so a maintenance job that
-- removes a whole college (db:dev:clean, the benchmark) could never delete a question and its versions together.
-- NO ACTION, deferred to the end of the transaction, protects exactly the same thing (a version that is still the current
-- one of a question cannot disappear alone) and lets both rows go in one transaction. The application never deletes
-- either table (lms_app has no DELETE), so nothing changes for it.
ALTER TABLE lms.questions DROP CONSTRAINT questions_current_version_fk;
ALTER TABLE lms.questions ADD CONSTRAINT questions_current_version_fk
  FOREIGN KEY (tenant_id, current_version_id) REFERENCES lms.question_versions (tenant_id, id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
