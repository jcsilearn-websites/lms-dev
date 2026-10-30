import type { ParticipationType } from './catalog';

/**
 * Resolves a user's participation in an OFFERING (one run of a course in a term). The courses module
 * implements it (one indexed query, cached per request); services call it ONLY for offering-scoped
 * checks and pass the result to `can()` as `resource.participation`. Hot read paths (the course outline,
 * "my courses") fold the same condition into their own single statement instead, to stay inside the
 * round-trip budget.
 */
export interface CourseParticipationResolver {
  resolve(input: {
    tenantId: string;
    userId: string;
    offeringId: string;
  }): Promise<ParticipationType | null>;
}

export const noCourseParticipation: CourseParticipationResolver = {
  resolve: async () => null,
};
