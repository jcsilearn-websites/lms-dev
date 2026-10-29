-- Step 4 (expand): a membership can now be 'suspended'.
-- Its own file: a new enum value cannot be used in the transaction that adds it, and the migration
-- runner uses one transaction per file. Everything that ALREADY treats "not active" as "no access"
-- (auth_lookup_session, auth_login_begin / auth_login_complete) keeps working unchanged: suspended
-- members cannot log in and their sessions stop resolving.
ALTER TYPE lms.membership_status ADD VALUE IF NOT EXISTS 'suspended';
