import { Type } from '@sinclair/typebox';
import {
  COMMON_ERRORS,
  ErrorResponseSchema,
  FileParamsSchema,
  FileSchema,
  OfferingParamsSchema,
  RequestUploadResponseSchema,
  RequestUploadSchema,
} from '../../contracts';

const tags = ['files'];

export const requestUploadRouteSchema = {
  tags,
  summary:
    'Ask for a signed URL to upload a file to an offering (instructors); the file stays pending until confirmed',
  params: OfferingParamsSchema,
  body: RequestUploadSchema,
  response: { 201: RequestUploadResponseSchema, 413: ErrorResponseSchema, ...COMMON_ERRORS },
};

export const confirmUploadRouteSchema = {
  tags,
  summary:
    'Confirm an upload: the server reads the bytes, checks size and type, and marks the file ready',
  params: FileParamsSchema,
  response: { 200: FileSchema, 413: ErrorResponseSchema, ...COMMON_ERRORS },
};

const tokenParams = Type.Object({ token: Type.String({ minLength: 10, maxLength: 1500 }) });

export const storageUploadRouteSchema = {
  tags: ['storage'],
  summary: 'Local storage driver only (development): upload bytes to a signed URL',
  params: tokenParams,
  response: { 204: Type.Null(), 413: ErrorResponseSchema, ...COMMON_ERRORS },
};

export const storageDownloadRouteSchema = {
  tags: ['storage'],
  summary: 'Local storage driver only (development): download from a signed URL',
  params: tokenParams,
  // the body is a binary stream, not JSON: no response schema for 200
  response: { 403: ErrorResponseSchema, 404: ErrorResponseSchema, 429: ErrorResponseSchema },
};
