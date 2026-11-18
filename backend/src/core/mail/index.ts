export { guardEmailProvider } from './guard';
export {
  brandColor,
  contrast,
  displayName,
  escapeHtml,
  html,
  oneLine,
  SafeHtml,
  safeUrl,
} from './html';
export {
  createCapturingProvider,
  createConsoleProvider,
  createFileProvider,
  createNullProvider,
} from './providers';
export { createTokenBucket, type RateLimiter } from './rate';
export { createSendgridProvider, parseAddress, type SendgridConfig } from './sendgrid';
export {
  createSendgridWebhookAdapter,
  SIGNATURE_HEADER as SENDGRID_SIGNATURE_HEADER,
  TIMESTAMP_HEADER as SENDGRID_TIMESTAMP_HEADER,
} from './sendgrid-webhook';
export { createSmtpProvider, type SmtpConfig, smtpErrorIsPermanent } from './smtp';
export {
  CATEGORY_LABELS,
  contentOf,
  formatWhen,
  type RenderedEmail,
  render,
  TEMPLATE_NAMES,
  TEMPLATE_PARAMS,
  type TemplateContext,
  TemplateError,
  type TemplateName,
} from './templates';
export { type EmailProvider, EmailSendError, type OutgoingEmail, type SendResult } from './types';
export {
  createUnsubscribeTokens,
  type UnsubscribeClaims,
  type UnsubscribeTokens,
  type UnsubscribeVerdict,
  unsubscribeKey,
} from './unsubscribe';
export type {
  BounceWebhookAdapter,
  EmailEventKind,
  NormalizedEmailEvent,
  WebhookRequest,
  WebhookVerdict,
} from './webhooks';
