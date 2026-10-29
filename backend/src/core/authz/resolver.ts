import type { ParticipationType } from './catalog';

/**
 * Resolves a user's participation in a course. The courses module implements this in a later step;
 * services call it ONLY for course-scoped checks and pass the result to `can()` as
 * `resource.participation`. Until then the stub says nobody participates anywhere.
 */
export interface CourseParticipationResolver {
  resolve(input: {
    tenantId: string;
    userId: string;
    courseId: string;
  }): Promise<ParticipationType | null>;
}

export const noCourseParticipation: CourseParticipationResolver = {
  resolve: async () => null,
};
