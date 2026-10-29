import { type Static, Type } from '@sinclair/typebox';

export const ErrorResponseSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    details: Type.Optional(
      Type.Array(Type.Object({ path: Type.String(), message: Type.String() })),
    ),
  }),
});
export type ErrorResponse = Static<typeof ErrorResponseSchema>;

/** Error statuses every endpoint can answer with (standard error shape). */
export const COMMON_ERRORS = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  429: ErrorResponseSchema,
  503: ErrorResponseSchema,
};
