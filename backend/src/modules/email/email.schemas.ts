import { Type } from '@sinclair/typebox';
import {
  COMMON_ERRORS,
  ErrorResponseSchema,
  MyEmailStatusSchema,
  SetEmailSenderRequestSchema,
  SuppressionPageSchema,
} from '../../contracts';

const tags = ['email'];
const Id = Type.String({ format: 'uuid' });
const PageQuery = Type.Object(
  {
    after: Type.Optional(Id),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
export const IdParams = Type.Object({ id: Id });
export const ProviderParams = Type.Object({
  provider: Type.String({ pattern: '^[a-z0-9-]{1,30}$' }),
});
export const SuppressionQuery = PageQuery;

export const myEmailStatusRouteSchema = {
  tags,
  summary: "Is the signed-in member's own address suppressed (bouncing)? Drives the in-app banner",
  response: { 200: MyEmailStatusSchema, ...COMMON_ERRORS },
};
export const listSuppressionsRouteSchema = {
  tags,
  summary: "Suppressed (bouncing / complained) addresses of THIS college's members",
  querystring: PageQuery,
  response: { 200: SuppressionPageSchema, ...COMMON_ERRORS },
};
export const clearSuppressionRouteSchema = {
  tags,
  summary: "Clear a member's suppression (mail is sent to the address again). Audited",
  params: IdParams,
  response: { 204: Type.Null(), ...COMMON_ERRORS },
};
export const webhookRouteSchema = {
  tags,
  summary:
    'Provider event webhook (bounces, complaints). Signature-verified over the raw body; feeds the suppression list',
  params: ProviderParams,
  response: {
    200: Type.Object({ received: Type.Integer() }),
    413: ErrorResponseSchema,
    415: ErrorResponseSchema,
    ...COMMON_ERRORS,
  },
};
export const platformListSuppressionsRouteSchema = {
  tags: ['platform'],
  summary: 'Every suppressed address (admin host)',
  querystring: PageQuery,
  response: { 200: SuppressionPageSchema, ...COMMON_ERRORS },
};
export const platformClearSuppressionRouteSchema = {
  tags: ['platform'],
  summary: 'Clear any suppression (admin host). Audited',
  params: IdParams,
  response: { 204: Type.Null(), ...COMMON_ERRORS },
};
export const setEmailSenderRouteSchema = {
  tags: ['platform'],
  summary:
    "Set a college's VERIFIED From address once its domain is authenticated at the provider (null = JCS default). Audited",
  params: IdParams,
  body: SetEmailSenderRequestSchema,
  response: { 204: Type.Null(), ...COMMON_ERRORS },
};
