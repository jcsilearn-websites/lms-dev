-- Step 10b: `ON CONFLICT ... DO UPDATE SET position = ...` (re-ordering attachments and feedback files in one statement)
-- needs UPDATE on that column. Nothing else about these tables changes.
GRANT UPDATE (position) ON lms.assignment_attachments TO lms_app;
GRANT UPDATE (position) ON lms.assignment_feedback_files TO lms_app;
