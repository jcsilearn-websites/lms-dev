import { Type } from '@sinclair/typebox';
import {
  COMMON_ERRORS,
  ConfirmImportRequestSchema,
  IdParamsSchema,
  ImportListQuerySchema,
  ImportListSchema,
  ImportRowsQuerySchema,
  ImportRowsSchema,
  ImportSchema,
  UploadQuerySchema,
} from '../../contracts';

const tags = ['imports'];
const csv = Type.String();

export const templateRouteSchema = (kind: string) => ({
  tags,
  summary: `Download the ${kind} CSV template (exact headers)`,
  response: { 200: csv, ...COMMON_ERRORS },
});

export const uploadRouteSchema = {
  tags,
  summary:
    'Upload a CSV (multipart, field "file", ?kind=students|faculty): streamed into staging and validated (dry run); nothing is imported yet',
  querystring: UploadQuerySchema,
  response: {
    201: ImportSchema,
    ...COMMON_ERRORS,
    410: COMMON_ERRORS[404],
    413: COMMON_ERRORS[400],
  },
};

export const listRouteSchema = {
  tags,
  summary: 'My college imports, newest first',
  querystring: ImportListQuerySchema,
  response: { 200: ImportListSchema, ...COMMON_ERRORS },
};

export const getRouteSchema = {
  tags,
  summary: 'Status and counts of an import (refreshed after every batch while it runs)',
  params: IdParamsSchema,
  response: { 200: ImportSchema, ...COMMON_ERRORS },
};

export const rowsRouteSchema = {
  tags,
  summary: 'The staged rows with their errors (review the dry run); filter by status',
  params: IdParamsSchema,
  querystring: ImportRowsQuerySchema,
  response: { 200: ImportRowsSchema, ...COMMON_ERRORS, 410: COMMON_ERRORS[404] },
};

export const errorsCsvRouteSchema = {
  tags,
  summary: 'Download the error report (rows not imported, with the reason); formula-safe CSV',
  params: IdParamsSchema,
  response: { 200: csv, ...COMMON_ERRORS, 410: COMMON_ERRORS[404] },
};

export const confirmRouteSchema = {
  tags,
  summary: 'Confirm a validated import: it is queued and processed in the background',
  params: IdParamsSchema,
  body: Type.Optional(ConfirmImportRequestSchema),
  response: { 200: ImportSchema, ...COMMON_ERRORS },
};

export const cancelRouteSchema = {
  tags,
  summary: 'Cancel a validated import that has not been confirmed',
  params: IdParamsSchema,
  response: { 200: ImportSchema, ...COMMON_ERRORS },
};
