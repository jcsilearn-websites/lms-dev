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
    'platform.usage.read',
    'platform.email.manage',
    'platform.account_erasure.manage',
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
    'course.read',
    'course.create',
    'course.manage',
    'offering.manage',
    'participant.read',
    'content.view',
    'progress.view_class',
    'question.read',
    'assessment.view_accommodations',
    'assignment.view_extensions',
    'rubric.read',
    'gradebook.read',
    'gradebook.approve',
    'gradescale.manage',
    'atrisk.view',
    'academic.read',
    'academic.manage',
    'profile.read_own',
    'profile.manage',
    'import.run',
    'notification.settings.manage',
    'email.suppression.manage',
    'privacy.erasure.approve',
  ]),
  // every active member reads the academic structure and their own profile; `profile_type`
  // (student / faculty / staff) is only a LABEL and grants nothing
  member: new Set<Permission>(['academic.read', 'profile.read_own']),
};

/** Offering-scoped permissions, granted by the caller's participation in THAT offering. */
export const PARTICIPATION_PERMISSIONS: Readonly<
  Record<ParticipationType, ReadonlySet<Permission>>
> = {
  instructor: new Set<Permission>([
    'content.view',
    'participant.read',
    'course.edit',
    'course.publish',
    'progress.view_class',
    'question.read',
    'question.manage',
    'assessment.create',
    'assessment.analyze',
    'assessment.view_accommodations',
    'assignment.manage',
    'assignment.view_extensions',
    'rubric.read',
    'rubric.manage',
    'submission.grade',
    'grade.finalize',
    'gradebook.read',
    'gradebook.manage',
    'gradebook.enter_marks',
    'gradebook.override',
    'atrisk.view',
  ]),
  assistant: new Set<Permission>([
    'content.view',
    'participant.read',
    'progress.view_class',
    'question.read',
    'rubric.read',
    'submission.grade',
    'gradebook.read',
    'gradebook.enter_marks',
    'atrisk.view',
  ]),
  // grade.view_own additionally requires resource.ownerUserId === the caller (see policy.ts)
  learner: new Set<Permission>([
    'content.view',
    'progress.record',
    'submission.create',
    'grade.view_own',
  ]),
};

/** The participation types that grant `permission` (for the SQL that decides access in one statement). */
export function participationsGranting(permission: Permission): ParticipationType[] {
  return (Object.keys(PARTICIPATION_PERMISSIONS) as ParticipationType[]).filter((p) =>
    PARTICIPATION_PERMISSIONS[p].has(permission),
  );
}
