// Public interface of the auth module: the ONLY file other modules (and the composition root) may import.
export {
  type AuthController,
  createAuthController,
  type SessionCookieConfig,
} from './auth.controller';
export * from './auth.errors';
export { createAuthHandlers } from './auth.handlers';
export { assertPasswordAllowed } from './auth.password-policy';
export { type AuthRepository, createAuthRepository } from './auth.repository';
export { createAuthRoutes } from './auth.routes';
export {
  type AuthConfig,
  type AuthService,
  createAuthService,
  DEFAULT_AUTH_CONFIG,
  type HostScope,
  type LoginResult,
} from './auth.service';
