import { NotFoundError } from '../../core/errors';

export class SessionNotFoundError extends NotFoundError {
  constructor() {
    super('session_not_found', 'Session not found');
  }
}
