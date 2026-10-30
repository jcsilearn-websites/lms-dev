import { Type } from '@sinclair/typebox';
import {
  AddCaptionRequestSchema,
  COMMON_ERRORS,
  CreateVideoRequestSchema,
  OfferingParamsSchema,
  OfferingVideoCaptionParamsSchema,
  OfferingVideoParamsSchema,
  OkResponseSchema,
  UploadOffsetSchema,
  VideoAssetSchema,
  VideoCaptionSchema,
  VideoUploadSchema,
} from '../../contracts';

const tags = ['video'];

export const createVideoRouteSchema = {
  tags,
  summary:
    'Start a resumable video upload for an offering (records the video, returns the chunk size)',
  params: OfferingParamsSchema,
  body: CreateVideoRequestSchema,
  response: { 201: VideoUploadSchema, ...COMMON_ERRORS },
};
export const getVideoRouteSchema = {
  tags,
  summary: 'A video: upload offset, processing status and progress, renditions, captions',
  params: OfferingVideoParamsSchema,
  response: { 200: VideoAssetSchema, ...COMMON_ERRORS },
};
export const getUploadRouteSchema = {
  tags,
  summary: 'Where the upload stands: the byte offset the next chunk must start at (resume point)',
  params: OfferingVideoParamsSchema,
  response: { 200: UploadOffsetSchema, ...COMMON_ERRORS },
};
// the chunk is the raw request body: no body schema
export const appendChunkRouteSchema = {
  tags,
  summary:
    'Send one chunk of the file (raw bytes). Headers: Upload-Offset (where this chunk starts) and Content-Length',
  params: OfferingVideoParamsSchema,
  response: { 200: UploadOffsetSchema, ...COMMON_ERRORS },
};
export const completeVideoRouteSchema = {
  tags,
  summary: 'The whole file is uploaded: start processing it',
  params: OfferingVideoParamsSchema,
  response: { 200: VideoAssetSchema, 202: VideoAssetSchema, ...COMMON_ERRORS },
};
export const deleteVideoRouteSchema = {
  tags,
  summary: 'Delete a video that no lesson uses',
  params: OfferingVideoParamsSchema,
  response: { 200: OkResponseSchema, ...COMMON_ERRORS },
};
export const addCaptionRouteSchema = {
  tags,
  summary: 'Add (or replace) the WebVTT captions of one language, at most 5 languages per video',
  params: OfferingVideoParamsSchema,
  body: AddCaptionRequestSchema,
  response: { 201: VideoCaptionSchema, ...COMMON_ERRORS },
};
export const deleteCaptionRouteSchema = {
  tags,
  summary: 'Remove the captions of one language',
  params: OfferingVideoCaptionParamsSchema,
  response: { 200: OkResponseSchema, ...COMMON_ERRORS },
};

export const playbackFileRouteSchema = {
  tags,
  summary:
    'Local video provider only (development): a file of a playback session (playlist, segment, poster, captions)',
  params: Type.Object({
    token: Type.String({ minLength: 10, maxLength: 600 }),
    assetId: Type.String({ format: 'uuid' }),
    '*': Type.String({ minLength: 1, maxLength: 200 }),
  }),
  // the body is media, not JSON: no response schema for 200 / 206
  response: { ...COMMON_ERRORS },
};
