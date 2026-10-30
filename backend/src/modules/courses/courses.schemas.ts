import {
  AddOfferingSectionRequestSchema,
  AddParticipantRequestSchema,
  COMMON_ERRORS,
  CourseListQuerySchema,
  CoursePageSchema,
  CourseParamsSchema,
  CourseSchema,
  CreateCourseRequestSchema,
  CreateOfferingRequestSchema,
  MyCoursesQuerySchema,
  OfferingListQuerySchema,
  OfferingPageSchema,
  OfferingParamsSchema,
  OfferingSchema,
  OfferingSectionParamsSchema,
  OfferingSectionsSchema,
  OkResponseSchema,
  ParticipantListQuerySchema,
  ParticipantPageSchema,
  ParticipantParamsSchema,
  ParticipantSchema,
  UpdateCourseRequestSchema,
  UpdateOfferingRequestSchema,
  UpdateParticipantRequestSchema,
} from '../../contracts';

const tags = ['courses'];

export const listCoursesRouteSchema = {
  tags,
  summary: 'Courses of the college (filter by department, or department=none)',
  querystring: CourseListQuerySchema,
  response: { 200: CoursePageSchema, ...COMMON_ERRORS },
};
export const getCourseRouteSchema = {
  tags,
  summary: 'One course',
  params: CourseParamsSchema,
  response: { 200: CourseSchema, ...COMMON_ERRORS },
};
export const createCourseRouteSchema = {
  tags,
  summary: 'Create a course (the department is optional); audited',
  body: CreateCourseRequestSchema,
  response: { 201: CourseSchema, ...COMMON_ERRORS },
};
export const updateCourseRouteSchema = {
  tags,
  summary:
    'Change or archive a course (archive is refused while offerings are not archived); audited',
  params: CourseParamsSchema,
  body: UpdateCourseRequestSchema,
  response: { 200: CourseSchema, ...COMMON_ERRORS },
};

export const listOfferingsRouteSchema = {
  tags,
  summary: 'Offerings of the college (administrators)',
  querystring: OfferingListQuerySchema,
  response: { 200: OfferingPageSchema, ...COMMON_ERRORS },
};
export const myCoursesRouteSchema = {
  tags,
  summary: 'My courses: the offerings I take part in (a learner sees published ones only)',
  querystring: MyCoursesQuerySchema,
  response: { 200: OfferingPageSchema, ...COMMON_ERRORS },
};
export const getOfferingRouteSchema = {
  tags,
  summary: 'One offering (404 for someone who does not take part in it and cannot administer it)',
  params: OfferingParamsSchema,
  response: { 200: OfferingSchema, ...COMMON_ERRORS },
};
export const createOfferingRouteSchema = {
  tags,
  summary: 'Create an offering of a course in a term (draft); audited',
  body: CreateOfferingRequestSchema,
  response: { 201: OfferingSchema, ...COMMON_ERRORS },
};
export const updateOfferingRouteSchema = {
  tags,
  summary: 'Change the label or title of an offering; audited',
  params: OfferingParamsSchema,
  body: UpdateOfferingRequestSchema,
  response: { 200: OfferingSchema, ...COMMON_ERRORS },
};
const statusRoute = (summary: string) => ({
  tags,
  summary,
  params: OfferingParamsSchema,
  response: { 200: OfferingSchema, ...COMMON_ERRORS },
});
export const publishOfferingRouteSchema = statusRoute(
  'Publish an offering (learners can then see it); audited',
);
export const unpublishOfferingRouteSchema = statusRoute('Take an offering back to draft; audited');
export const archiveOfferingRouteSchema = statusRoute(
  'Archive an offering (read-only, frozen class list); audited',
);

export const listSectionsRouteSchema = {
  tags,
  summary: 'Sections whose students are enrolled in the offering',
  params: OfferingParamsSchema,
  response: { 200: OfferingSectionsSchema, ...COMMON_ERRORS },
};
export const addSectionRouteSchema = {
  tags,
  summary:
    'Enrol a section: its students become learners (the sync runs in the background); audited',
  params: OfferingParamsSchema,
  body: AddOfferingSectionRequestSchema,
  response: { 200: OkResponseSchema, ...COMMON_ERRORS },
};
export const removeSectionRouteSchema = {
  tags,
  summary: 'Stop enrolling a section; learners it brought are removed by the sync; audited',
  params: OfferingSectionParamsSchema,
  response: { 200: OkResponseSchema, ...COMMON_ERRORS },
};

export const listParticipantsRouteSchema = {
  tags,
  summary: 'The class list of an offering',
  params: OfferingParamsSchema,
  querystring: ParticipantListQuerySchema,
  response: { 200: ParticipantPageSchema, ...COMMON_ERRORS },
};
export const addParticipantRouteSchema = {
  tags,
  summary: 'Add an instructor, assistant or learner by hand; audited',
  params: OfferingParamsSchema,
  body: AddParticipantRequestSchema,
  response: { 201: ParticipantSchema, ...COMMON_ERRORS },
};
export const updateParticipantRouteSchema = {
  tags,
  summary: "Change a participant's part (they become a manual participant); audited",
  params: ParticipantParamsSchema,
  body: UpdateParticipantRequestSchema,
  response: { 200: ParticipantSchema, ...COMMON_ERRORS },
};
export const removeParticipantRouteSchema = {
  tags,
  summary: 'Remove a participant (the sync never re-adds them); audited',
  params: ParticipantParamsSchema,
  response: { 200: OkResponseSchema, ...COMMON_ERRORS },
};
