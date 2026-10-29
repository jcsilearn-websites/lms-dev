import { BadRequestError } from '../../core/errors';

export class InvalidAuditEntryError extends BadRequestError {
  constructor(message: string) {
    super('invalid_audit_entry', message);
  }
}
