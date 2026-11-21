// Names of the advisory locks the application takes, so that two code paths guarding the same thing use the SAME key.
// `pg_advisory_xact_lock(hashtextextended(<key>, <class>))`, released at the end of the transaction. The class number keeps
// unrelated keys apart (10 = the learner's hand-in of one assignment, in SQL: assignment_submit / assignment_upload_begin).

/** Read-merge-write of a college's settings (PATCH): the second admin waits for the first and merges into what the first wrote. */
export const settingsLockKey = (tenantId: string): string => `tenant_settings:${tenantId}`;
export const SETTINGS_LOCK_CLASS = 12;
