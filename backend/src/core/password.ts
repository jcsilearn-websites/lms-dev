import { hash, verify } from '@node-rs/argon2';
import { ServiceBusyError } from './errors';

/**
 * argon2id with the OWASP-recommended minimum (m=19 MiB, t=2, p=1). Parameters live in the PHC
 * string, so they can be raised later: `needsRehash` flags hashes made with older parameters and
 * login rehashes them transparently.
 */
export const ARGON2_PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const normalize = (password: string) => password.normalize('NFKC');

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /**
   * `skipIf` is asked once the request has a hashing slot (after any queueing): when it answers true no
   * argon2 work is done and the result is false. Login uses it to drop guesses that queued behind the
   * guess that locked the account.
   */
  verify(passwordHash: string, password: string, skipIf?: () => boolean): Promise<boolean>;
  /** Verifies against a throwaway hash so unknown accounts cost the same as known ones. */
  verifyDummy(password: string): Promise<false>;
  needsRehash(passwordHash: string): boolean;
  /** Every hashing slot is taken and the wait queue is full: the next hash would be refused. */
  full(): boolean;
}

export function needsRehash(passwordHash: string, params = ARGON2_PARAMS): boolean {
  const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(passwordHash);
  if (!m) return true;
  return (
    Number(m[1]) !== params.memoryCost ||
    Number(m[2]) !== params.timeCost ||
    Number(m[3]) !== params.parallelism
  );
}

/**
 * Hashing runs on the libuv threadpool (it never blocks the event loop), but the pool is shared with
 * DNS lookups, so concurrency is capped and the wait queue is bounded: overflow fails fast with 503.
 */
export function createPasswordHasher(opts: {
  concurrency: number;
  maxQueue?: number;
  /** tests: argon2 calls that can be held open */
  argon2?: { hash: typeof hash; verify: typeof verify };
}): PasswordHasher {
  const maxQueue = opts.maxQueue ?? 50;
  const argon2 = opts.argon2 ?? { hash, verify };
  let running = 0;
  const waiting: Array<() => void> = [];

  const full = () => running >= opts.concurrency && waiting.length >= maxQueue;

  async function limited<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= opts.concurrency) {
      if (full()) throw new ServiceBusyError();
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiting.shift()?.();
    }
  }

  let dummy: Promise<string> | undefined;
  const dummyHash = () => {
    dummy ??= argon2.hash(normalize('dummy-password-for-timing'), ARGON2_PARAMS);
    return dummy;
  };

  return {
    hash: (password) => limited(() => argon2.hash(normalize(password), ARGON2_PARAMS)),
    verify: (passwordHash, password, skipIf) =>
      limited(() =>
        skipIf?.()
          ? Promise.resolve(false)
          : argon2.verify(passwordHash, normalize(password)).catch(() => false),
      ),
    async verifyDummy(password) {
      const h = await dummyHash();
      await limited(() => argon2.verify(h, normalize(password)).catch(() => false));
      return false;
    },
    needsRehash: (passwordHash) => needsRehash(passwordHash),
    full,
  };
}
