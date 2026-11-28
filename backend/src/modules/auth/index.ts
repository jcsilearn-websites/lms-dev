// Public interface of the auth module: the ONLY file other modules (and the composition root) may import.
export {
  type AuthController,
  createAuthController,
  type SessionCookieConfig,
} from './auth.controller';
export * from './auth.errors';
export { createAuthHandlers } from './auth.handlers';
export { createMfaRepository, type MfaRepository } from './auth.mfa.repository';
export {
  createMfaService,
  MFA_CHALLENGE_TTL_SECONDS,
  MFA_ENROL_CHALLENGE_TTL_SECONDS,
  MFA_ENROL_LINK_TTL_SECONDS,
  type MfaService,
} from './auth.mfa.service';
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
  type SessionStarted,
} from './auth.service';
