import { sql } from 'drizzle-orm';
import type { CourseParticipationResolver, ParticipationType } from '../../core/authz';
import type { Database } from '../../db/client';

/**
 * The courses module's implementation of CourseParticipationResolver: ONE indexed query (the member's active
 * participation in that offering, through their active membership), cached for the life of the resolver.
 * `forRequest()` returns a resolver with its own cache: create one per request, so a change made by another
 * request is seen by the next one and never served from a stale cache. The hot paths (the outline, my courses,
 * every mutation of an offering) do not call it: they fold the same condition into their own single statement
 * (courses.access.ts) to stay inside the round-trip budget.
 */
export function createCourseParticipationResolver(deps: { db: Pick<Database, 'withTenant'> }) {
  const { db } = deps;

  function forRequest(): CourseParticipationResolver {
    const cache = new Map<string, Promise<ParticipationType | null>>();
    return {
      resolve({ tenantId, userId, offeringId }) {
        const key = `${tenantId}|${userId}|${offeringId}`;
        let hit = cache.get(key);
        if (!hit) {
          hit = db.withTenant(tenantId, async (tx) => {
            const res = await tx.execute(sql`
              SELECT p.participation::text AS participation
                FROM lms.course_participants p
                JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
               WHERE p.tenant_id = ${tenantId}::uuid AND p.offering_id = ${offeringId}::uuid
                 AND m.user_id = ${userId}::uuid AND m.status = 'active' AND p.status = 'active'
               LIMIT 1`);
            return (res.rows[0]?.participation as ParticipationType | undefined) ?? null;
          });
          cache.set(key, hit);
          // a failed lookup must not be remembered
          hit.catch(() => cache.delete(key));
        }
        return hit;
      },
    };
  }

  return { forRequest };
}
export type CourseParticipationResolverFactory = ReturnType<
  typeof createCourseParticipationResolver
>;
