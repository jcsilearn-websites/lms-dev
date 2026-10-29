import type { AccountRole, ParticipationType, Permission } from './catalog';

// Role -> permission mapping, in code. Deny by default: anything not listed is not granted.

/** Account-level permissions. */
export const ACCOUNT_ROLE_PERMISSIONS: Readonly<Record<AccountRole, ReadonlySet<Permission>>> = {
  // admin host only
  platform_admin: new Set<Permission>([
    'platform.tenant.read',
    'platform.tenant.manage',
    'platform.audit.read',
    'platform.user.unlock',
  ]),
  // tenant host only. content.view is read-only access to every course of the tenant; editing,
  // publishing, assessments and grading need a course participation.
  institution_admin: new Set<Permission>([
    'tenant.manage',
    'member.read',
    'member.invite',
    'member.update_role',
    'member.suspend',
    'member.remove',
    'member.unlock',
    'audit.read',
    'report.view',
    'course.create',
    'content.view',
    'academic.read',
    'academic.manage',
    'profile.read_own',
    'profile.manage',
    'import.run',
  ]),
  // every active member reads the academic structure and their own profile; `profile_type`
  // (student / faculty / staff) is only a LABEL and grants nothing
  member: new Set<Permission>(['academic.read', 'profile.read_own']),
};

/** Course-scoped permissions, granted by the caller-supplied participation in THAT course. */
export const PARTICIPATION_PERMISSIONS: Readonly<
  Record<ParticipationType, ReadonlySet<Permission>>
> = {
  instructor: new Set<Permission>([
    'content.view',
    'course.edit',
    'course.publish',
    'assessment.create',
    'submission.grade',
    'grade.finalize',
  ]),
  assistant: new Set<Permission>(['content.view', 'submission.grade']),
  // grade.view_own additionally requires resource.ownerUserId === the caller (see policy.ts)
  learner: new Set<Permission>(['content.view', 'submission.create', 'grade.view_own']),
};
