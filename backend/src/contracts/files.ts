import { type Static, Type } from '@sinclair/typebox';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });

export const FileSchema = Type.Object({
  id: Id,
  name: Type.String(),
  contentType: Type.String(),
  /** The size the uploader declared until the upload is confirmed, then the measured size. */
  size: Type.Integer(),
  status: Type.Union([Type.Literal('pending'), Type.Literal('ready')]),
  createdAt: DateTime,
});
export type FileDto = Static<typeof FileSchema>;

export const FileParamsSchema = Type.Object({ id: Id });

/** Ask for a place to upload ONE file to an offering. */
export const RequestUploadSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  size: Type.Integer({ minimum: 1 }),
});

export const UploadTargetSchema = Type.Object({
  url: Type.String(),
  method: Type.Literal('PUT'),
  headers: Type.Record(Type.String(), Type.String()),
  expiresAt: DateTime,
});

export const RequestUploadResponseSchema = Type.Object({
  file: FileSchema,
  upload: UploadTargetSchema,
  /** The largest file the college accepts, in bytes. */
  maxBytes: Type.Integer(),
});

export type RequestUploadResponse = Static<typeof RequestUploadResponseSchema>;

export const DownloadTargetSchema = Type.Object({
  url: Type.String(),
  expiresAt: DateTime,
  fileName: Type.String(),
  /** shown in the browser (PDF, PNG, JPEG) or downloaded */
  inline: Type.Boolean(),
});
export type DownloadTargetDto = Static<typeof DownloadTargetSchema>;
