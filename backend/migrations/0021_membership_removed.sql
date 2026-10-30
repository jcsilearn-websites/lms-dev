-- Step 6b (expand): a membership can be 'removed'. Academic history (participation, later submissions and grades)
-- hangs off memberships, so the app never deletes a membership: removing a member sets this status instead.
-- A new enum value cannot be used in the transaction that adds it, so this file does nothing else (see 0022).
ALTER TYPE lms.membership_status ADD VALUE IF NOT EXISTS 'removed';
