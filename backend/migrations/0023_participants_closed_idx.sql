-- The enrolment sync looks up a member's CLOSED (removed) participations when they come back: a small partial index
-- (removed rows are rare) keeps that a per-member probe instead of a scan.
CREATE INDEX course_participants_closed_idx ON lms.course_participants (tenant_id, membership_id)
  WHERE status = 'removed';
