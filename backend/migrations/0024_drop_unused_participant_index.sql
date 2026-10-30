-- course_participants_section_idx (tenant, offering, source_section_id) was never used: removing a section marks the
-- section's STUDENTS for the sync (by their profile), it never looks participants up by section. Every unused index
-- is paid for on every enrolment row the sync inserts (200,000 rows for 10,000 students x 20 courses).
DROP INDEX lms.course_participants_section_idx;
