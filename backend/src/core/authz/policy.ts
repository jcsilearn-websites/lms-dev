import type { AccountRole, ParticipationType, Permission } from './catalog';
import { ACCOUNT_ROLE_PERMISSIONS, PARTICIPATION_PERMISSIONS } from './roles';

/** The minimal caller description `can()` needs (a RequestContext satisfies it). */
export interface AuthzSubject {
  userId: string;
  /** null = admin host (platform scope). */
  tenantId: string | null;
  role: 'institution_admin' | 'member' | null;
  isPlatformAdmin: boolean;
}

/** The resource a check is about. Everything is optional: account-level checks need none. */
export interface AuthzResource {
  /** When set it must equal the caller's tenant: a resource of another tenant is never allowed. */
  tenantId?: string | undefined;
  /** The caller's resolved participation in the course (supplied by the caller, see resolver.ts). */
  participation?: ParticipationType | null | undefined;
  /** Owner of the object (e.g. the learner whose submission/grade this is). */
  ownerUserId?: string | undefined;
}

/** The account role a request is acting as: platform scope on the admin host, else the membership. */
export function accountRoleOf(subject: AuthzSubject): AccountRole | null {
  if (subject.tenantId === null) return subject.isPlatformAdmin ? 'platform_admin' : null;
  return subject.role;
}

/**
 * The single authorization policy. Deny by default. Pure and synchronous: account-level checks are
 * a Set lookup (no DB). Course-scoped permissions are granted by `resource.participation`, which
 * the caller resolves (CourseParticipationResolver) and passes in.
 */
export function can(
  subject: AuthzSubject,
  permission: Permission,
  resource?: AuthzResource,
): boolean {
  if (resource?.tenantId !== undefined && resource.tenantId !== subject.tenantId) return false;

  const role = accountRoleOf(subject);
  if (role !== null && ACCOUNT_ROLE_PERMISSIONS[role].has(permission)) return true;

  const participation = resource?.participation;
  if (!participation || subject.tenantId === null) return false;
  if (!PARTICIPATION_PERMISSIONS[participation].has(permission)) return false;
  // learners see their own grades only
  if (permission === 'grade.view_own') return resource?.ownerUserId === subject.userId;
  return true;
}
