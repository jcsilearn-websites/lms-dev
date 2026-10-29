import { NotFoundError } from '../../core/errors';

export class UserNotFoundError extends NotFoundError {
  constructor() {
    super('user_not_found', 'User not found');
  }
}
