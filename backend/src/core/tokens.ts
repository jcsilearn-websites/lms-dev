import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const randomBytesAsync = promisify(randomBytes);

/** 32 random bytes, base64url: used for session cookies and emailed invite/reset links. */
export async function generateToken(): Promise<string> {
  return (await randomBytesAsync(32)).toString('base64url');
}

/**
 * SHA-256 of a token (what the database stores). Hashing a 43-character string takes microseconds,
 * so it is done inline rather than on the threadpool; the slow KDF (argon2) is async.
 */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
