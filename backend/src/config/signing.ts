import { parseSigningKeys, type SigningKeyEntry } from '../core/keyring';

/** The signing-key ring settings of an environment (SIGNING_KEYS, SIGNING_LEGACY_TOKENS). */
export function signingFromEnv(env: {
  SIGNING_KEYS?: string | undefined;
  SIGNING_LEGACY_TOKENS?: string | undefined;
}): { entries: readonly SigningKeyEntry[]; legacyEnabled: boolean } {
  return {
    entries: parseSigningKeys(env.SIGNING_KEYS),
    legacyEnabled: env.SIGNING_LEGACY_TOKENS !== 'off',
  };
}
