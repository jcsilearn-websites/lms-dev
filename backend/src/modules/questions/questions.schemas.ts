import { Type } from '@sinclair/typebox';
import {
  COMMON_ERRORS,
  ConfirmQuestionImportSchema,
  DownloadTargetSchema,
  QuestionCourseParamsSchema,
  QuestionGetQuerySchema,
  QuestionImportParamsSchema,
  QuestionImportRowsQuerySchema,
  QuestionImportRowsSchema,
  QuestionImportSchema,
  QuestionInputSchema,
  QuestionListQuerySchema,
  QuestionPageSchema,
  QuestionParamsSchema,
  QuestionSchema,
  QuestionVersionsSchema,
  TagsSchema,
} from '../../contracts';

const tags = ['questions'];

export const listRouteSchema = {
  tags,
  summary: 'The question bank of a course (newest first, keyset), with the answer keys',
  params: QuestionCourseParamsSchema,
  querystring: QuestionListQuerySchema,
  response: { 200: QuestionPageSchema, ...COMMON_ERRORS },
};
export const tagsRouteSchema = {
  tags,
  summary: 'The tags used in the question bank of a course, with their counts',
  params: QuestionCourseParamsSchema,
  response: { 200: TagsSchema, ...COMMON_ERRORS },
};
export const getRouteSchema = {
  tags,
  summary: 'One question (the current version, or ?version=n)',
  params: QuestionParamsSchema,
  querystring: QuestionGetQuerySchema,
  response: { 200: QuestionSchema, ...COMMON_ERRORS },
};
export const versionsRouteSchema = {
  tags,
  summary: 'The versions of a question, newest first',
  params: QuestionParamsSchema,
  response: { 200: QuestionVersionsSchema, ...COMMON_ERRORS },
};
export const createRouteSchema = {
  tags,
  summary: 'Create a question',
  params: QuestionCourseParamsSchema,
  body: QuestionInputSchema,
  response: { 201: QuestionSchema, ...COMMON_ERRORS },
};
export const updateRouteSchema = {
  tags,
  summary: 'Edit a question: saves a NEW version (past attempts keep the version they showed)',
  params: QuestionParamsSchema,
  body: QuestionInputSchema,
  response: { 200: QuestionSchema, ...COMMON_ERRORS },
};
export const archiveRouteSchema = {
  tags,
  summary: 'Archive a question (hidden from lists and random pools)',
  params: QuestionParamsSchema,
  response: { 200: QuestionSchema, ...COMMON_ERRORS },
};
export const unarchiveRouteSchema = {
  tags,
  summary: 'Bring an archived question back',
  params: QuestionParamsSchema,
  response: { 200: QuestionSchema, ...COMMON_ERRORS },
};
export const imageRouteSchema = {
  tags,
  summary: 'A short-lived signed download URL for an image of a question',
  params: Type.Object({
    courseId: Type.String({ format: 'uuid' }),
    questionId: Type.String({ format: 'uuid' }),
    fileId: Type.String({ format: 'uuid' }),
  }),
  response: { 200: DownloadTargetSchema, ...COMMON_ERRORS },
};

export const templateRouteSchema = {
  tags,
  summary: 'The CSV template for importing choice questions',
  params: QuestionCourseParamsSchema,
  response: { 200: Type.String(), ...COMMON_ERRORS },
};
export const uploadImportRouteSchema = {
  tags,
  summary:
    'Upload a CSV of choice questions (at most 1,000 rows): validated row by row, nothing is created yet',
  params: QuestionCourseParamsSchema,
  response: { 201: QuestionImportSchema, ...COMMON_ERRORS },
};
export const getImportRouteSchema = {
  tags,
  summary: 'An import and its counts',
  params: QuestionImportParamsSchema,
  response: { 200: QuestionImportSchema, ...COMMON_ERRORS },
};
export const importRowsRouteSchema = {
  tags,
  summary: 'The staged rows of an import with their errors (keyset)',
  params: QuestionImportParamsSchema,
  querystring: QuestionImportRowsQuerySchema,
  response: { 200: QuestionImportRowsSchema, ...COMMON_ERRORS },
};
export const confirmImportRouteSchema = {
  tags,
  summary: 'Create the questions of a staged import (skipInvalid when some rows are invalid)',
  params: QuestionImportParamsSchema,
  body: ConfirmQuestionImportSchema,
  response: { 200: QuestionImportSchema, ...COMMON_ERRORS },
};
export const cancelImportRouteSchema = {
  tags,
  summary: 'Throw a staged import away',
  params: QuestionImportParamsSchema,
  response: { 200: QuestionImportSchema, ...COMMON_ERRORS },
};
