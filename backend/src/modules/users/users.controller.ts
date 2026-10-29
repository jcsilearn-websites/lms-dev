import type { UsersService } from './users.service';

// Reads the validated request, calls the service, maps the result to the response DTO.
// No DB access, no business rules. No endpoints yet, so there is nothing to map.
export function createUsersController(_deps: { usersService: UsersService }) {
  return {};
}
export type UsersController = ReturnType<typeof createUsersController>;
