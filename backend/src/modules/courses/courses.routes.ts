import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { CoursesController } from './courses.controller';
import * as s from './courses.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic.
// `scope: 'offering'` routes only need a session at the hook: the service decides in the same statement as
// the work whether the caller takes part in THIS offering (404 if not) and may do the action (403 if not).
export function createCoursesRoutes(deps: {
  coursesController: CoursesController;
}): FastifyPluginAsyncTypebox {
  const { coursesController: c } = deps;
  return async (app) => {
    app.get(
      '/courses',
      { config: { permission: 'course.read' }, schema: s.listCoursesRouteSchema },
      c.listCourses,
    );
    app.post(
      '/courses',
      { config: { permission: 'course.create' }, schema: s.createCourseRouteSchema },
      c.createCourse,
    );
    app.get(
      '/courses/:id',
      { config: { permission: 'course.read' }, schema: s.getCourseRouteSchema },
      c.getCourse,
    );
    app.patch(
      '/courses/:id',
      { config: { permission: 'course.manage' }, schema: s.updateCourseRouteSchema },
      c.updateCourse,
    );

    app.get(
      '/offerings',
      { config: { permission: 'course.read' }, schema: s.listOfferingsRouteSchema },
      c.listOfferings,
    );
    app.post(
      '/offerings',
      { config: { permission: 'offering.manage' }, schema: s.createOfferingRouteSchema },
      c.createOffering,
    );
    app.get(
      '/me/courses',
      { config: { authenticated: true }, schema: s.myCoursesRouteSchema },
      c.myCourses,
    );
    app.get(
      '/offerings/:id',
      {
        config: { permission: 'content.view', scope: 'offering' },
        schema: s.getOfferingRouteSchema,
      },
      c.getOffering,
    );
    app.patch(
      '/offerings/:id',
      {
        config: { permission: 'offering.manage', scope: 'offering' },
        schema: s.updateOfferingRouteSchema,
      },
      c.updateOffering,
    );
    app.post(
      '/offerings/:id/publish',
      {
        config: { permission: 'course.publish', scope: 'offering' },
        schema: s.publishOfferingRouteSchema,
      },
      c.publish,
    );
    app.post(
      '/offerings/:id/unpublish',
      {
        config: { permission: 'course.publish', scope: 'offering' },
        schema: s.unpublishOfferingRouteSchema,
      },
      c.unpublish,
    );
    app.post(
      '/offerings/:id/archive',
      {
        config: { permission: 'offering.manage', scope: 'offering' },
        schema: s.archiveOfferingRouteSchema,
      },
      c.archive,
    );

    app.get(
      '/offerings/:id/sections',
      {
        config: { permission: 'offering.manage', scope: 'offering' },
        schema: s.listSectionsRouteSchema,
      },
      c.listSections,
    );
    app.post(
      '/offerings/:id/sections',
      {
        config: { permission: 'offering.manage', scope: 'offering' },
        schema: s.addSectionRouteSchema,
      },
      c.addSection,
    );
    app.delete(
      '/offerings/:id/sections/:sectionId',
      {
        config: { permission: 'offering.manage', scope: 'offering' },
        schema: s.removeSectionRouteSchema,
      },
      c.removeSection,
    );

    app.get(
      '/offerings/:id/participants',
      {
        config: { permission: 'participant.read', scope: 'offering' },
        schema: s.listParticipantsRouteSchema,
      },
      c.listParticipants,
    );
    app.post(
      '/offerings/:id/participants',
      {
        config: { permission: 'offering.manage', scope: 'offering' },
        schema: s.addParticipantRouteSchema,
      },
      c.addParticipant,
    );
    app.patch(
      '/offerings/:id/participants/:participantId',
      {
        config: { permission: 'offering.manage', scope: 'offering' },
        schema: s.updateParticipantRouteSchema,
      },
      c.updateParticipant,
    );
    app.delete(
      '/offerings/:id/participants/:participantId',
      {
        config: { permission: 'offering.manage', scope: 'offering' },
        schema: s.removeParticipantRouteSchema,
      },
      c.removeParticipant,
    );
  };
}
