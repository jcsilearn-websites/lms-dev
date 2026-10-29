import { ServiceUnavailableError } from '../../core/errors';

export class NotReadyError extends ServiceUnavailableError {
  constructor(options?: { cause?: unknown }) {
    super('not_ready', 'Database is not reachable', options);
  }
}
