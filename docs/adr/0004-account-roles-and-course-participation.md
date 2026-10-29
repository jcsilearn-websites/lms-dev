# ADR 0004: Three account roles + per-course participation

Status: accepted

## Context

Role explosion (student, faculty, TA, admin…) at the account level makes permissions brittle. What a person can do
in a course depends on their relationship to that course, not on a global title.

## Decision

Exactly three account roles: **Platform Admin** (`users.is_platform_admin`, not a tenant member by default; every
in-tenant action is audited), **Institution Admin** and **Member** (`tenant_memberships.role` enum with exactly
`institution_admin | member`). Students, faculty and TAs are all `member`. Course capability comes from a course
participation type — `instructor | assistant | learner` — added with the course tables in a later step.
Authorization checks permission names (`course.edit`, `submission.grade`), never role strings in route code.

## Consequences

- A person can be a learner in one course and an instructor in another without new account roles.
- A permission layer maps (account role, participation type) → permission names; adding capabilities does not touch routes.
