import {
  COMMON_ERRORS,
  RubricArchiveRequestSchema,
  RubricCourseParamsSchema,
  RubricDetailSchema,
  RubricInputSchema,
  RubricListQuerySchema,
  RubricListSchema,
  RubricParamsSchema,
} from '../../contracts';

const tags = ['rubrics'];

export const listRouteSchema = {
  tags,
  summary: 'The rubrics of a course (newest first, keyset)',
  params: RubricCourseParamsSchema,
  querystring: RubricListQuerySchema,
  response: { 200: RubricListSchema, ...COMMON_ERRORS },
};
export const getRouteSchema = {
  tags,
  summary: 'One rubric with its current criteria and levels',
  params: RubricParamsSchema,
  response: { 200: RubricDetailSchema, ...COMMON_ERRORS },
};
export const createRouteSchema = {
  tags,
  summary: 'Create a rubric (criteria x levels x points)',
  params: RubricCourseParamsSchema,
  body: RubricInputSchema,
  response: { 201: RubricDetailSchema, ...COMMON_ERRORS },
};
export const updateRouteSchema = {
  tags,
  summary: 'Edit a rubric: adds a new immutable version (grades keep the version they used)',
  params: RubricParamsSchema,
  body: RubricInputSchema,
  response: { 200: RubricDetailSchema, ...COMMON_ERRORS },
};
export const archiveRouteSchema = {
  tags,
  summary: 'Archive or restore a rubric (assignments that use it keep working)',
  params: RubricParamsSchema,
  body: RubricArchiveRequestSchema,
  response: { 200: RubricDetailSchema, ...COMMON_ERRORS },
};
