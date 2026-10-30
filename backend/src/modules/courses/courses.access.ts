import { type SQL, sql } from 'drizzle-orm';
import type { ParticipationType } from '../../core/authz';
import { ForbiddenError } from '../../core/errors';
import { pgArray } from '../../core/pg-array';
import { OfferingNotFoundError } from './courses.errors';

// How "can this caller do X in THIS offering" is decided: inside the same statement as the work (one round
// trip, no check-then-act gap). The statement carries a CTE named `acc`; the service reads its row and maps
// it with assertAccess(): not visible -> 404 (a non-participant never learns the offering exists),
// visible but not allowed -> 403.

export interface AccessRow {
  id: string;
  status: 'draft' | 'published' | 'archived';
  participation: ParticipationType | null;
  visible: boolean;
  allowed: boolean;
}

export interface AccessSpec {
  tenantId: string;
  userId: string;
  offeringId: string;
  /** The caller may see every offering of the college (course.read: institution administrators). */
  viewAll: boolean;
  /** Allowed by the ACCOUNT role alone (e.g. offering.manage for an administrator). */
  accountAllowed: boolean;
  /** Participation types that allow the action (participationsGranting(permission)). */
  allowedBy: readonly ParticipationType[];
  /** Lock the offering row (mutations). */
  lock?: boolean;
  /** The CTE's name (default `acc`); a statement that checks two offerings names the second one. */
  name?: string;
}

/**
 * `acc AS (...)`: at most one row (id, status, participation, visible, allowed).
 * visible: administrators see everything; instructors and assistants see drafts; learners only a published
 * offering. allowed: the account role allows it, or the participation type grants it.
 */
export function accessCte(a: AccessSpec): SQL {
  return sql`${sql.raw(a.name ?? 'acc')} AS (
    SELECT o.id, o.status::text AS status, mp.participation::text AS participation,
           (${a.viewAll}::boolean OR mp.participation IN ('instructor', 'assistant')
            OR (mp.participation = 'learner' AND o.status = 'published')) AS visible,
           (${a.accountAllowed}::boolean OR mp.participation::text = ANY(${pgArray(a.allowedBy)}::text[])) AS allowed
      FROM lms.course_offerings o
      LEFT JOIN LATERAL (
        SELECT p.participation FROM lms.course_participants p
          JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
         WHERE p.tenant_id = o.tenant_id AND p.offering_id = o.id AND m.user_id = ${a.userId}::uuid
           AND p.status = 'active'
         LIMIT 1) mp ON true
     WHERE o.tenant_id = ${a.tenantId}::uuid AND o.id = ${a.offeringId}::uuid
     ${a.lock ? sql`FOR UPDATE OF o` : sql``})`;
}

/** 404 when the offering is missing or not visible to the caller; 403 when visible but not allowed. */
export function assertAccess(acc: AccessRow | null | undefined): AccessRow {
  if (!acc?.visible) throw new OfferingNotFoundError();
  if (!acc.allowed) throw new ForbiddenError();
  return acc;
}
