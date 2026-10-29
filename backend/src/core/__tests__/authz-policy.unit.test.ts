import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_ROLE_PERMISSIONS,
  ALL_PERMISSIONS,
  type AuthzSubject,
  type CourseParticipationResolver,
  can,
  declarationCount,
  noCourseParticipation,
  PARTICIPATION_PERMISSIONS,
  type ParticipationType,
  type Permission,
} from '../authz';

const T1 = '00000000-0000-7000-8000-000000000001';
const T2 = '00000000-0000-7000-8000-000000000002';
const admin: AuthzSubject = {
  userId: 'u-admin',
  tenantId: T1,
  role: 'institution_admin',
  isPlatformAdmin: false,
};
const member: AuthzSubject = {
  userId: 'u-member',
  tenantId: T1,
  role: 'member',
  isPlatformAdmin: false,
};
const platform: AuthzSubject = {
  userId: 'u-root',
  tenantId: null,
  role: null,
  isPlatformAdmin: true,
};

describe('can(): account level', () => {
  it('denies everything by default: a plain member only reads the academic structure and their own profile', () => {
    for (const p of ALL_PERMISSIONS) {
      expect(can(member, p), p).toBe(p === 'academic.read' || p === 'profile.read_own');
    }
  });

  it('gives institution admins the tenant set and read-only content, but no course edit rights', () => {
    for (const p of ACCOUNT_ROLE_PERMISSIONS.institution_admin) expect(can(admin, p)).toBe(true);
    for (const p of [
      'course.edit',
      'course.publish',
      'assessment.create',
      'submission.grade',
      'grade.finalize',
      'submission.create',
      'grade.view_own',
    ] as Permission[]) {
      expect(can(admin, p), p).toBe(false);
    }
    expect(can(admin, 'content.view')).toBe(true);
    expect(can(admin, 'report.view')).toBe(true);
    expect(can(admin, 'course.create')).toBe(true);
  });

  it('never gives institution admins platform permissions', () => {
    for (const p of ACCOUNT_ROLE_PERMISSIONS.platform_admin) expect(can(admin, p)).toBe(false);
  });

  it('gives platform admins on the admin host only the platform set', () => {
    for (const p of ALL_PERMISSIONS) {
      expect(can(platform, p), p).toBe(ACCOUNT_ROLE_PERMISSIONS.platform_admin.has(p));
    }
  });

  it('a platform-admin flag does not help on a tenant host', () => {
    const onTenantHost: AuthzSubject = { ...member, isPlatformAdmin: true };
    // the flag adds nothing: exactly what a plain member has, no platform permission
    for (const p of ALL_PERMISSIONS) expect(can(onTenantHost, p), p).toBe(can(member, p));
  });

  it('a user with no role anywhere is denied', () => {
    const nobody: AuthzSubject = {
      userId: 'x',
      tenantId: null,
      role: null,
      isPlatformAdmin: false,
    };
    for (const p of ALL_PERMISSIONS) expect(can(nobody, p)).toBe(false);
  });

  it('denies a resource of another tenant, even for an admin', () => {
    expect(can(admin, 'content.view', { tenantId: T2 })).toBe(false);
    expect(can(admin, 'content.view', { tenantId: T1 })).toBe(true);
  });
});

describe('can(): course participation', () => {
  const as = (participation: ParticipationType | null, extra = {}) => ({
    participation,
    tenantId: T1,
    ...extra,
  });

  it('grants exactly the mapped permissions per participation type', () => {
    for (const type of ['instructor', 'assistant', 'learner'] as const) {
      for (const p of ALL_PERMISSIONS) {
        if (p === 'grade.view_own') continue; // needs the owner, tested below
        expect(can(member, p, as(type)), `${type} ${p}`).toBe(
          PARTICIPATION_PERMISSIONS[type].has(p) || ACCOUNT_ROLE_PERMISSIONS.member.has(p),
        );
      }
    }
  });

  it('instructor edits, publishes, creates assessments, grades and finalizes', () => {
    for (const p of [
      'course.edit',
      'course.publish',
      'assessment.create',
      'submission.grade',
      'grade.finalize',
    ] as const) {
      expect(can(member, p, as('instructor'))).toBe(true);
    }
  });

  it('assistant grades but can neither publish nor finalize', () => {
    expect(can(member, 'submission.grade', as('assistant'))).toBe(true);
    expect(can(member, 'course.publish', as('assistant'))).toBe(false);
    expect(can(member, 'grade.finalize', as('assistant'))).toBe(false);
    expect(can(member, 'course.edit', as('assistant'))).toBe(false);
  });

  it('learner views content and submits, but cannot grade or edit', () => {
    expect(can(member, 'content.view', as('learner'))).toBe(true);
    expect(can(member, 'submission.create', as('learner'))).toBe(true);
    for (const p of ['submission.grade', 'course.edit', 'grade.finalize'] as const) {
      expect(can(member, p, as('learner'))).toBe(false);
    }
  });

  it('a learner sees only their own grades', () => {
    expect(can(member, 'grade.view_own', as('learner', { ownerUserId: member.userId }))).toBe(true);
    expect(can(member, 'grade.view_own', as('learner', { ownerUserId: 'someone-else' }))).toBe(
      false,
    );
    expect(can(member, 'grade.view_own', as('learner'))).toBe(false);
  });

  it('no participation (or none supplied) means no course permission', () => {
    expect(can(member, 'content.view', as(null))).toBe(false);
    expect(can(member, 'submission.grade')).toBe(false);
  });

  it('an institution admin who is an instructor gets instructor rights; otherwise not', () => {
    expect(can(admin, 'course.edit', as('instructor'))).toBe(true);
    expect(can(admin, 'course.edit', as(null))).toBe(false);
  });

  it('a participation in a course of another tenant grants nothing', () => {
    expect(can(member, 'content.view', { participation: 'instructor', tenantId: T2 })).toBe(false);
  });

  it('works with a fake resolver supplied by the caller', async () => {
    const participations = new Map<string, ParticipationType>([['c1:u-member', 'assistant']]);
    const resolver: CourseParticipationResolver = {
      resolve: async ({ courseId, userId }) => participations.get(`${courseId}:${userId}`) ?? null,
    };
    const p1 = await resolver.resolve({ tenantId: T1, userId: member.userId, courseId: 'c1' });
    expect(can(member, 'submission.grade', { participation: p1, tenantId: T1 })).toBe(true);
    const p2 = await resolver.resolve({ tenantId: T1, userId: member.userId, courseId: 'c2' });
    expect(can(member, 'submission.grade', { participation: p2, tenantId: T1 })).toBe(false);
    expect(
      await noCourseParticipation.resolve({ tenantId: T1, userId: 'x', courseId: 'c' }),
    ).toBeNull();
  });
});

describe('route declarations', () => {
  it('counts exactly the declared kinds', () => {
    expect(declarationCount(undefined)).toBe(0);
    expect(declarationCount({})).toBe(0);
    expect(declarationCount({ public: true })).toBe(1);
    expect(declarationCount({ authenticated: true })).toBe(1);
    expect(declarationCount({ permission: 'member.read' })).toBe(1);
    expect(declarationCount({ permission: ['member.unlock', 'platform.user.unlock'] })).toBe(1);
    expect(declarationCount({ public: true, authenticated: true })).toBe(2);
    expect(declarationCount({ public: false })).toBe(0);
  });
});
