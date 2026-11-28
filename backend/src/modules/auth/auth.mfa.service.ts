import type { MfaEnrolStartResponse, MfaStatus } from '../../contracts';
import type { ClientInfo, RequestContext } from '../../core/context';
import {
  type MfaCrypto,
  MfaKeyError,
  newRecoveryCodes,
  normalizeRecoveryCode,
} from '../../core/mfa-crypto';
import type { PasswordHasher } from '../../core/password';
import { generateToken, hashToken } from '../../core/tokens';
import { base32Encode, matchTotpStep, newTotpSecret, otpauthUri } from '../../core/totp';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import {
  InvalidCredentialsError,
  InvalidTokenError,
  MfaChallengeInvalidError,
  MfaCodeInvalidError,
  MfaCodeRequiredError,
  MfaLockedError,
} from './auth.errors';
import type { MfaRepository, SessionInput, SignedIn } from './auth.mfa.repository';
import type { AuthRepository } from './auth.repository';

// TWO-FACTOR SIGN-IN (step 14c, docs/adr/0026-mfa.md). The database decides every state change (lockout, replay, single use, audit);
// this service only does what needs the key (encrypt / decrypt the secret, hash a recovery code) or argon2.

export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;
export const MFA_ENROL_CHALLENGE_TTL_SECONDS = 10 * 60;
export const MFA_ENROL_LINK_TTL_SECONDS = 30 * 60;
/** code tries (and, separately, recovery-code tries) of one challenge */
export const MFA_TRIES_PER_CHALLENGE = 5;
const ISSUER = 'JCS iLearn';

export interface MfaTenant {
  id: string;
  slug: string;
}

export interface MfaSignIn {
  /** the raw session cookie token: returned once, only its SHA-256 is stored */
  token: string;
  signedIn: SignedIn;
}

export interface MfaServiceConfig {
  /** platform and institution administrators are FORCED to enrol */
  enforced: boolean;
  sessionIdleSeconds: number;
  sessionAbsoluteSeconds: number;
  /** the PASSWORD lockout (a wrong password on the enrolment page counts like a wrong sign-in) */
  maxAttempts: number;
  lockBaseSeconds: number;
  lockMaxSeconds: number;
}

export function createMfaService(deps: {
  db: Pick<Database, 'withoutTenant'>;
  mfaRepo: MfaRepository;
  authRepo: Pick<AuthRepository, 'loginFailed'>;
  hasher: Pick<PasswordHasher, 'verify' | 'verifyDummy'>;
  /** null in a process that was given no key (the worker, which never reads a secret) */
  crypto: MfaCrypto | null;
  config: MfaServiceConfig;
  /** every time decision of the second factor uses this clock (tests pass explicit instants) */
  now?: () => Date;
}) {
  const { db, mfaRepo, authRepo, hasher, config } = deps;
  const keys = (): MfaCrypto => {
    if (!deps.crypto)
      throw new MfaKeyError('MFA_ENCRYPTION_KEYS is not configured in this process');
    return deps.crypto;
  };
  const now = deps.now ?? (() => new Date());
  const tenantIdOf = (tenant: MfaTenant | null) => tenant?.id ?? null;

  async function newSession(client: ClientInfo): Promise<{ token: string; input: SessionInput }> {
    const token = await generateToken();
    return {
      token,
      input: {
        sessionId: newId(),
        tokenHash: hashToken(token),
        idleSeconds: config.sessionIdleSeconds,
        absoluteSeconds: config.sessionAbsoluteSeconds,
        ip: client.ip,
        userAgent: client.userAgent,
      },
    };
  }

  async function verifyTotp(
    challengeHash: Buffer,
    code: string,
    tenant: MfaTenant | null,
    client: ClientInfo,
  ): Promise<MfaSignIn> {
    const at = now();
    // charged and audited BEFORE the code is looked at
    const attempt = await db.withoutTenant((exec) =>
      mfaRepo.totpAttempt(exec, {
        challengeHash,
        tenantId: tenantIdOf(tenant),
        maxPerChallenge: MFA_TRIES_PER_CHALLENGE,
        ip: client.ip,
        auditId: newId(),
        lockAuditId: newId(),
        now: at,
      }),
    );
    if (attempt.status === 'locked') throw new MfaLockedError(attempt.retryAfterSeconds);
    if (attempt.status !== 'ok') throw new MfaChallengeInvalidError();
    const step = matchTotpStep(keys().open(attempt.userId, attempt.sealed), code, at);
    if (step === null) throw new MfaCodeInvalidError();
    const session = await newSession(client);
    const result = await db.withoutTenant((exec) =>
      mfaRepo.totpAccept(exec, {
        ...session.input,
        challengeHash,
        tenantId: tenantIdOf(tenant),
        step,
        auditId: newId(),
        now: at,
      }),
    );
    // a code that was already used answers like a wrong one
    if (result.status === 'replayed') throw new MfaCodeInvalidError();
    if (result.status !== 'ok') throw new MfaChallengeInvalidError();
    return { token: session.token, signedIn: result.signedIn };
  }

  async function useRecoveryCode(
    challengeHash: Buffer,
    input: string,
    tenant: MfaTenant | null,
    client: ClientInfo,
  ): Promise<MfaSignIn> {
    // something that cannot be a code is still COUNTED: it is hashed like any other and matches nothing
    const candidates = keys().recoveryCandidates(normalizeRecoveryCode(input) ?? '');
    const session = await newSession(client);
    const result = await db.withoutTenant((exec) =>
      mfaRepo.recoveryUse(exec, {
        ...session.input,
        challengeHash,
        tenantId: tenantIdOf(tenant),
        candidates,
        maxPerChallenge: MFA_TRIES_PER_CHALLENGE,
        auditId: newId(),
        loginAuditId: newId(),
        now: now(),
      }),
    );
    if (result.status === 'locked') throw new MfaLockedError(result.retryAfterSeconds);
    if (result.status === 'wrong') throw new MfaCodeInvalidError();
    if (result.status !== 'ok') throw new MfaChallengeInvalidError();
    return { token: session.token, signedIn: result.signedIn };
  }

  return {
    enforced: config.enforced,

    /**
     * The password was right. An enrolled person gets a challenge (no session); a person who must enrol and has not gets the
     * enrolment link by e-mail (no session, no challenge). null = the account may not sign in here after all.
     */
    async afterPassword(input: {
      userId: string;
      enrolled: boolean;
      tenantId: string | null;
      client: ClientInfo;
    }): Promise<{ step: 'totp'; challengeToken: string } | { step: 'enrol_email' } | null> {
      if (!input.enrolled) {
        const queued = await db.withoutTenant((exec) =>
          mfaRepo.enrolLinkRequested(exec, {
            userId: input.userId,
            tenantId: input.tenantId,
            key: `mfa-enrol:${newId()}`,
            auditId: newId(),
            ip: input.client.ip,
          }),
        );
        return queued ? { step: 'enrol_email' } : null;
      }
      const challengeToken = await generateToken();
      const created = await db.withoutTenant((exec) =>
        mfaRepo.challengeCreate(exec, {
          id: newId(),
          tokenHash: hashToken(challengeToken),
          userId: input.userId,
          tenantId: input.tenantId,
          ttlSeconds: MFA_CHALLENGE_TTL_SECONDS,
          ip: input.client.ip,
          userAgent: input.client.userAgent,
          auditId: newId(),
          now: now(),
        }),
      );
      return created ? { step: 'totp', challengeToken } : null;
    },

    /** The second step of a sign-in: exactly one of a code of the app and a recovery code. */
    async verify(input: {
      challengeToken: string | undefined;
      code?: string | undefined;
      recoveryCode?: string | undefined;
      tenant: MfaTenant | null;
      client: ClientInfo;
    }): Promise<MfaSignIn> {
      if ((input.code === undefined) === (input.recoveryCode === undefined)) {
        throw new MfaCodeRequiredError();
      }
      if (!input.challengeToken) throw new MfaChallengeInvalidError();
      const challengeHash = hashToken(input.challengeToken);
      return input.code !== undefined
        ? verifyTotp(challengeHash, input.code, input.tenant, input.client)
        : useRecoveryCode(challengeHash, input.recoveryCode as string, input.tenant, input.client);
    },

    /** The emailed link AND the password: neither a mailbox nor a stolen password is enough on its own. */
    async startEnrolment(input: {
      token: string;
      password: string;
      tenant: MfaTenant | null;
      client: ClientInfo;
    }): Promise<MfaEnrolStartResponse & { challengeToken: string }> {
      const tenantId = tenantIdOf(input.tenant);
      const tokenHash = hashToken(input.token);
      const at = now();
      const target = await db.withoutTenant((exec) =>
        mfaRepo.enrolLookup(exec, tokenHash, tenantId, at),
      );
      if (!target) throw new InvalidTokenError();
      const locked = !!target.lockedUntil && target.lockedUntil.getTime() > Date.now();
      const passwordOk = locked
        ? await hasher.verifyDummy(input.password)
        : await hasher.verify(target.passwordHash, input.password);
      if (locked || !passwordOk) {
        if (!locked) {
          await db.withoutTenant((exec) =>
            authRepo.loginFailed(exec, {
              userId: target.userId,
              tenantId,
              countAttempt: true,
              reason: 'bad_password_mfa_enrol',
              maxAttempts: config.maxAttempts,
              baseSeconds: config.lockBaseSeconds,
              maxSeconds: config.lockMaxSeconds,
              ip: input.client.ip,
              auditId: newId(),
              lockAuditId: newId(),
            }),
          );
        }
        throw new InvalidCredentialsError();
      }
      const secret = newTotpSecret();
      const challengeToken = await generateToken();
      const started = await db.withoutTenant((exec) =>
        mfaRepo.enrolStart(exec, {
          tokenHash,
          tenantId,
          id: newId(),
          challengeHash: hashToken(challengeToken),
          sealed: keys().seal(target.userId, secret),
          ttlSeconds: MFA_ENROL_CHALLENGE_TTL_SECONDS,
          ip: input.client.ip,
          userAgent: input.client.userAgent,
          auditId: newId(),
          now: at,
        }),
      );
      if (!started) throw new InvalidTokenError();
      return {
        secret: base32Encode(secret),
        otpauthUri: otpauthUri({ secret, account: target.email, issuer: ISSUER }),
        challengeToken,
      };
    },

    /** The first code of the app: the factor exists from now on, and this browser is signed in. */
    async confirmEnrolment(input: {
      challengeToken: string | undefined;
      code: string;
      tenant: MfaTenant | null;
      client: ClientInfo;
    }): Promise<MfaSignIn & { recoveryCodes: string[] }> {
      if (!input.challengeToken) throw new MfaChallengeInvalidError();
      const challengeHash = hashToken(input.challengeToken);
      const tenantId = tenantIdOf(input.tenant);
      const at = now();
      const attempt = await db.withoutTenant((exec) =>
        mfaRepo.enrolAttempt(exec, {
          challengeHash,
          tenantId,
          max: MFA_TRIES_PER_CHALLENGE,
          ip: input.client.ip,
          auditId: newId(),
          now: at,
        }),
      );
      if (!attempt) throw new MfaChallengeInvalidError();
      const step = matchTotpStep(keys().open(attempt.userId, attempt.sealed), input.code, at);
      if (step === null) throw new MfaCodeInvalidError();
      const recoveryCodes = newRecoveryCodes();
      const codes = recoveryCodes.map((c) =>
        keys().hashRecoveryCode(normalizeRecoveryCode(c) as string),
      );
      const session = await newSession(input.client);
      const signed = await db.withoutTenant((exec) =>
        mfaRepo.enrolComplete(exec, {
          ...session.input,
          challengeHash,
          tenantId,
          step,
          codeIds: codes.map(() => newId()),
          codes,
          auditId: newId(),
          loginAuditId: newId(),
          now: at,
        }),
      );
      if (!signed) throw new MfaChallengeInvalidError();
      return { token: session.token, signedIn: signed, recoveryCodes };
    },

    /** Sign-in challenges are gone a day after they expired (they hold an address and a user agent). */
    async purgeChallenges(batchSize: number, maxBatches = 100): Promise<number> {
      let total = 0;
      for (let i = 0; i < maxBatches; i++) {
        const n = await db.withoutTenant((exec) => mfaRepo.purgeChallenges(exec, batchSize));
        total += n;
        if (n < batchSize) break;
      }
      return total;
    },

    /** My own second factor (never the secret). */
    async status(ctx: RequestContext): Promise<MfaStatus> {
      const s = await db.withoutTenant((exec) => mfaRepo.status(exec, ctx.userId));
      return {
        required: ctx.tenantId ? ctx.role === 'institution_admin' : ctx.isPlatformAdmin,
        enrolled: s.enrolledAt !== null,
        enrolledAt: s.enrolledAt?.toISOString() ?? null,
        recoveryCodesRemaining: s.recoveryCodesRemaining,
      };
    },
  };
}
export type MfaService = ReturnType<typeof createMfaService>;
