import {
  ClassPageSchema,
  ClassQuerySchema,
  COMMON_ERRORS,
  HeartbeatRequestSchema,
  HeartbeatResponseSchema,
  ItemProgressParamsSchema,
  LearnerDrilldownSchema,
  LearnerParamsSchema,
  MarkResponseSchema,
  MyOfferingsProgressSchema,
  MyProgressSchema,
  OfferingParamsSchema,
} from '../../contracts';

const tags = ['progress'];

export const heartbeatRouteSchema = {
  tags,
  summary:
    'A video player reports the seconds it played since its last heartbeat (learners only; the server merges, clamps and never double counts)',
  params: ItemProgressParamsSchema,
  body: HeartbeatRequestSchema,
  response: { 200: HeartbeatResponseSchema, ...COMMON_ERRORS },
};
export const viewedRouteSchema = {
  tags,
  summary: 'The learner opened (or downloaded) the item: completes an "on view" item',
  params: ItemProgressParamsSchema,
  response: { 200: MarkResponseSchema, ...COMMON_ERRORS },
};
export const completeRouteSchema = {
  tags,
  summary: 'Mark an item that is marked done by hand as done',
  params: ItemProgressParamsSchema,
  response: { 200: MarkResponseSchema, ...COMMON_ERRORS },
};
export const uncompleteRouteSchema = {
  tags,
  summary: 'Undo "mark as done"',
  params: ItemProgressParamsSchema,
  response: { 200: MarkResponseSchema, ...COMMON_ERRORS },
};
export const mineRouteSchema = {
  tags,
  summary: 'My progress in an offering: per item, per module, overall, and where to continue',
  params: OfferingParamsSchema,
  response: { 200: MyProgressSchema, ...COMMON_ERRORS },
};
export const mineEverywhereRouteSchema = {
  tags,
  summary: 'My progress in every course I learn in, and where to continue (My courses)',
  response: { 200: MyOfferingsProgressSchema, ...COMMON_ERRORS },
};
export const classRouteSchema = {
  tags,
  summary: 'The class progress table (filter by section and status, sort, keyset pagination)',
  params: OfferingParamsSchema,
  querystring: ClassQuerySchema,
  response: { 200: ClassPageSchema, ...COMMON_ERRORS },
};
export const classCsvRouteSchema = {
  tags,
  summary: 'The class progress table as a CSV file (streamed, formula-injection safe)',
  params: OfferingParamsSchema,
  querystring: ClassQuerySchema,
  // the body is a CSV stream, not JSON: no response schema for 200
  response: { ...COMMON_ERRORS },
};
export const learnerRouteSchema = {
  tags,
  summary: 'One learner: every item with status, watched share and last activity',
  params: LearnerParamsSchema,
  response: { 200: LearnerDrilldownSchema, ...COMMON_ERRORS },
};
