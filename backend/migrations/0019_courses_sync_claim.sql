-- The sync worker claims pending rows with SELECT ... FOR UPDATE SKIP LOCKED, which needs the UPDATE
-- privilege on at least one column of the table (PostgreSQL requires it for row locks). The key column is the
-- only one and the table is only ever inserted into, read and deleted, so this grants nothing useful beyond
-- the lock itself.
GRANT UPDATE (membership_id) ON lms.course_sync_pending TO lms_app;
