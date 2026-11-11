-- Step 10e: copying an offering now brings the assessments' settings along (dates moved), so the copy statement inserts
-- the `assessments` row itself (until now only the default-row trigger did). The columns are the settings; the row can
-- never be deleted by the application and attempts still cannot be copied (they are not in the statement).
GRANT INSERT ON lms.assessments TO lms_app;
