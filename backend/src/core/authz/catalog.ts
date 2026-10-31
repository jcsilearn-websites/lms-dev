// The permission catalog: every permission the system knows, grouped by area. Authorization is
// always checked against these names, never against role strings in route or service code.
export const PERMISSION_GROUPS = {
  tenant: ['tenant.manage'],
  member: [
    'member.read',
    'member.invite',
    'member.update_role',
    'member.suspend',
    'member.remove',
    'member.unlock',
  ],
  audit: ['audit.read', 'report.view'],
  academic: ['academic.read', 'academic.manage'],
  profile: ['profile.read_own', 'profile.manage'],
  import: ['import.run'],
  course: [
    'course.read',
    'course.create',
    'course.manage',
    'offering.manage',
    'participant.read',
    'course.edit',
    'course.publish',
    'content.view',
    'assessment.create',
    'submission.create',
    'submission.grade',
    'grade.finalize',
    'grade.view_own',
    'progress.record',
    'progress.view_class',
  ],
  platform: [
    'platform.tenant.read',
    'platform.tenant.manage',
    'platform.audit.read',
    'platform.user.unlock',
  ],
} as const;

export type PermissionGroup = keyof typeof PERMISSION_GROUPS;
export type Permission = (typeof PERMISSION_GROUPS)[PermissionGroup][number];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSION_GROUPS).flat();

/** What a participation in an OFFERING (one run of a course in a term) grants. */
export const PARTICIPATION_TYPES = ['instructor', 'assistant', 'learner'] as const;
export type ParticipationType = (typeof PARTICIPATION_TYPES)[number];

/** The account-level roles of the system: exactly three. */
export const ACCOUNT_ROLES = ['platform_admin', 'institution_admin', 'member'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** What each permission allows, in one line (shown in docs/permissions.md). Exhaustive on purpose. */
export const PERMISSION_DESCRIPTIONS: Readonly<Record<Permission, string>> = {
  'tenant.manage': 'Manage the college settings',
  'member.read': 'List and view the members of the college',
  'member.invite': 'Invite people and resend invites',
  'member.update_role': 'Change a member role (institution admin / member)',
  'member.suspend': 'Suspend and reactivate members',
  'member.remove': 'Remove a membership (the global user is kept)',
  'member.unlock': 'Clear a login lockout of a member',
  'audit.read': "Read the college's audit log",
  'report.view': 'View reports',
  'academic.read':
    'View the academic structure (years, terms, departments, programs, batches, sections)',
  'academic.manage': 'Create, change, archive and delete academic structure',
  'profile.read_own': 'View your own member profile',
  'profile.manage': 'View and change member profiles; move students between sections',
  'import.run': 'Upload, validate, confirm and monitor bulk CSV imports',
  'course.read': 'View the course catalog of the college',
  'course.create': 'Create courses',
  'course.manage': 'Change and archive courses',
  'offering.manage':
    'Create and change offerings (a course in a term), assign instructors and assistants, enrol sections and learners',
  'participant.read': 'See the class list of an offering',
  'course.edit': 'Edit the content of an offering (modules, items, files)',
  'course.publish': 'Publish and unpublish an offering; copy content from another offering',
  'content.view': 'View the content of an offering',
  'progress.record': 'Record your own learning progress (watching, opening, marking done)',
  'progress.view_class': 'View the learning progress of the learners of an offering; export it',
  'assessment.create': 'Create assessments',
  'submission.create': 'Submit work',
  'submission.grade': 'Grade submissions',
  'grade.finalize': 'Finalize grades',
  'grade.view_own': 'See your own grades only',
  'platform.tenant.read': 'View colleges and (audited) their members',
  'platform.tenant.manage': 'Create, rename, suspend colleges and invite their admins',
  'platform.audit.read': 'Read the platform audit log',
  'platform.user.unlock': 'Clear a login lockout (admin host)',
};
