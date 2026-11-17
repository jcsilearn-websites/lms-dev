// Public interface of the email module (outbox delivery, suppressions, provider webhooks): the ONLY file other modules
// (and the composition root) may import.
export { createEmailController, type EmailController } from './email.controller';
export { createEmailHandlers } from './email.handlers';
export { createEmailRepository, type EmailRepository } from './email.repository';
export { createEmailRoutes } from './email.routes';
export {
  createEmailService,
  type EmailService,
  type EmailServiceConfig,
  type SecurityTokens,
} from './email.service';
