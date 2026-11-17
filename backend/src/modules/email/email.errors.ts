import { NotFoundError, ServiceUnavailableError, UnauthorizedError } from '../../core/errors';

export class SuppressionNotFoundError extends NotFoundError {
  constructor() {
    super('suppression_not_found', 'This address is not on the suppression list');
  }
}

export class UnknownWebhookProviderError extends NotFoundError {
  constructor() {
    super('webhook_provider_unknown', 'No webhook adapter for this provider');
  }
}

export class WebhookNotConfiguredError extends ServiceUnavailableError {
  constructor() {
    super('webhook_not_configured', 'This webhook is not configured');
  }
}

/** A signature that does not verify (or is missing / too old). Nothing is recorded. */
export class WebhookSignatureError extends UnauthorizedError {
  constructor() {
    super('webhook_signature_invalid', 'Webhook signature verification failed');
  }
}

export class CollegeNotFoundError extends NotFoundError {
  constructor() {
    super('tenant_not_found', 'College not found');
  }
}
