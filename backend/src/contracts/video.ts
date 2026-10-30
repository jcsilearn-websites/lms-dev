import { type Static, type TSchema, Type } from '@sinclair/typebox';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([Type.Null(), t]);

// Video lessons (step 7). A video is an ASSET (this file) that a content item of kind 'video' references.

export const VIDEO_STATUSES = ['uploading', 'processing', 'ready', 'failed'] as const;
export const VideoStatusSchema = Type.Union([
  Type.Literal('uploading'),
  Type.Literal('processing'),
  Type.Literal('ready'),
  Type.Literal('failed'),
]);
export type VideoStatus = Static<typeof VideoStatusSchema>;

export const VideoRenditionSchema = Type.Object({
  name: Type.String(),
  width: Type.Integer(),
  height: Type.Integer(),
  videoKbps: Type.Integer(),
  /** size of this rendition's segments on disk */
  bytes: Type.Integer(),
});

const LanguagePattern = '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$';

export const VideoCaptionSchema = Type.Object({
  id: Id,
  /** BCP 47 style: en, hi, pt-BR */
  language: Type.String({ pattern: LanguagePattern }),
  label: Type.String({ minLength: 1, maxLength: 60 }),
  sizeBytes: Type.Integer(),
});
export type VideoCaption = Static<typeof VideoCaptionSchema>;

export const VideoErrorSchema = Type.Object({ code: Type.String(), message: Type.String() });

/** What the outline / an item says about its video (no captions, no renditions: the builder asks for those). */
export const ItemVideoSchema = Type.Object({
  id: Id,
  status: VideoStatusSchema,
  /** 0..100 while processing */
  progress: Type.Integer(),
  durationMs: Nullable(Type.Integer()),
});
export type ItemVideo = Static<typeof ItemVideoSchema>;

export const VideoAssetSchema = Type.Object({
  id: Id,
  offeringId: Id,
  fileName: Type.String(),
  status: VideoStatusSchema,
  progress: Type.Integer(),
  /** bytes of the original stored so far: the next chunk starts here */
  uploadOffset: Type.Integer(),
  size: Type.Integer(),
  durationMs: Nullable(Type.Integer()),
  width: Nullable(Type.Integer()),
  height: Nullable(Type.Integer()),
  hasAudio: Type.Union([Type.Null(), Type.Boolean()]),
  renditions: Type.Array(VideoRenditionSchema),
  captions: Type.Array(VideoCaptionSchema),
  error: Type.Union([Type.Null(), VideoErrorSchema]),
  /** the original is still stored (it is deleted some days after a successful transcode) */
  sourceKept: Type.Boolean(),
  createdAt: DateTime,
  readyAt: Nullable(DateTime),
});
export type VideoAsset = Static<typeof VideoAssetSchema>;

export const VideoUploadSchema = Type.Object({
  video: VideoAssetSchema,
  upload: Type.Object({
    protocol: Type.Literal('chunked'),
    /** send the file in PATCH requests of at most this many bytes */
    chunkBytes: Type.Integer(),
    maxBytes: Type.Integer(),
  }),
});
export type VideoUpload = Static<typeof VideoUploadSchema>;

export const OfferingVideoParamsSchema = Type.Object({ id: Id, videoId: Id });
export const OfferingVideoCaptionParamsSchema = Type.Object({
  id: Id,
  videoId: Id,
  // the shape is checked by the service AFTER the access check (a stranger gets 404, not a validation error)
  language: Type.String({ minLength: 1, maxLength: 40 }),
});

export const CreateVideoRequestSchema = Type.Object({
  fileName: Type.String({ minLength: 1, maxLength: 255 }),
  size: Type.Integer({ minimum: 1 }),
});

export const UploadOffsetSchema = Type.Object({
  uploadOffset: Type.Integer(),
  size: Type.Integer(),
  status: VideoStatusSchema,
});
export type UploadOffset = Static<typeof UploadOffsetSchema>;

export const MAX_CAPTION_BYTES = 256 * 1024;
export const MAX_CAPTIONS_PER_VIDEO = 5;
export const AddCaptionRequestSchema = Type.Object({
  language: Type.String({ pattern: LanguagePattern }),
  label: Type.String({ minLength: 1, maxLength: 60 }),
  /** the WebVTT text (UTF-8, at most 256 KB) */
  content: Type.String({ minLength: 8, maxLength: MAX_CAPTION_BYTES }),
});

// ------------------------------------------------------------------ playback
export const PlaybackCaptionSchema = Type.Object({
  language: Type.String(),
  label: Type.String(),
  url: Type.String(),
});

export const PlaybackSessionSchema = Type.Object({
  manifestUrl: Type.String(),
  posterUrl: Nullable(Type.String()),
  expiresAt: DateTime,
  durationMs: Type.Integer(),
  captions: Type.Array(PlaybackCaptionSchema),
  renditions: Type.Array(Type.Object({ name: Type.String(), height: Type.Integer() })),
});
export type PlaybackSession = Static<typeof PlaybackSessionSchema>;
