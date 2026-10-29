import { describe, expect, it } from 'vitest';
import { assertValidEmail, normalizeEmail } from '../email';
import { buildOrigin, parseHost } from '../host';
import { createBackgroundTasks, createCapturingMailer } from '../mailer';
import { createPasswordHasher, needsRehash } from '../password';
import { generateToken, hashToken } from '../tokens';

describe('parseHost / buildOrigin', () => {
  it('classifies tenant, admin and unrelated hosts', () => {
    expect(parseHost('alpha.example.com', 'example.com')).toEqual({
      kind: 'tenant',
      slug: 'alpha',
      portSuffix: '',
    });
    expect(parseHost('Alpha-1.localhost:5173', 'localhost')).toEqual({
      kind: 'tenant',
      slug: 'alpha-1',
      portSuffix: ':5173',
    });
    expect(parseHost('admin.example.com', 'example.com')).toEqual({
      kind: 'admin',
      portSuffix: '',
    });
    for (const h of [
      'example.com',
      'localhost',
      'a.b.example.com',
      'alpha.evil.com',
      'x.example.com.evil.com',
      '',
      undefined,
      '[::1]',
      '-bad-.example.com',
    ]) {
      expect(parseHost(h, 'example.com').kind, String(h)).toBe('none');
    }
  });

  it('builds link origins only from the validated parts, never raw header text', () => {
    expect(
      buildOrigin({ kind: 'tenant', slug: 'alpha', portSuffix: ':5173' }, 'localhost', false),
    ).toBe('http://alpha.localhost:5173');
    expect(buildOrigin({ kind: 'admin', portSuffix: '' }, 'example.com', true)).toBe(
      'https://admin.example.com',
    );
    expect(buildOrigin({ kind: 'none' }, 'example.com', true)).toBeNull();
  });
});

describe('email normalisation', () => {
  it('trims and lowercases; rejects junk', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(assertValidEmail(' A@B.co ')).toBe('a@b.co');
    for (const bad of ['', 'no-at', 'a@b', 'a b@c.de', `${'x'.repeat(320)}@a.bc`]) {
      expect(() => assertValidEmail(bad), bad).toThrow();
    }
  });
});

describe('tokens', () => {
  it('are 32 random bytes base64url, unique, and hash to a 32-byte SHA-256', async () => {
    const [a, b] = [await generateToken(), await generateToken()];
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(hashToken(a)).toHaveLength(32);
    expect(hashToken(a).equals(hashToken(a))).toBe(true);
    expect(hashToken(a).equals(hashToken(b))).toBe(false);
  });
});

describe('password hasher (argon2id)', () => {
  it('produces PHC strings with the OWASP parameters, verifies, and flags old parameters for rehash', async () => {
    const hasher = createPasswordHasher({ concurrency: 2 });
    const hash = await hasher.hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await hasher.verify(hash, 'correct horse battery')).toBe(true);
    expect(await hasher.verify(hash, 'wrong')).toBe(false);
    expect(await hasher.verify('not a hash', 'x')).toBe(false);
    expect(hasher.needsRehash(hash)).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=4096,t=2,p=1$abc$def')).toBe(true);
    expect(needsRehash('$2b$10$bcrypt')).toBe(true);
  });

  it('normalises Unicode (NFKC) so visually identical passwords match', async () => {
    const hasher = createPasswordHasher({ concurrency: 2 });
    const hash = await hasher.hash('ﬁnal-passphrase'); // ligature
    expect(await hasher.verify(hash, 'final-passphrase')).toBe(true);
  });

  it('verifyDummy always returns false after doing real work', async () => {
    expect(await createPasswordHasher({ concurrency: 1 }).verifyDummy('anything')).toBe(false);
  });

  it('bounds concurrency: with the queue full, extra work fails fast with 503 instead of piling up', async () => {
    const hasher = createPasswordHasher({ concurrency: 1, maxQueue: 0 });
    const first = hasher.hash('first password here');
    const second = await hasher.hash('second password here').catch((e: unknown) => e);
    expect(second).toMatchObject({ statusCode: 503, code: 'busy' });
    await first;
  });
});

describe('background tasks and mailer', () => {
  it('drain waits for pending work and swallows task errors into the handler', async () => {
    const errors: unknown[] = [];
    const bg = createBackgroundTasks((e) => errors.push(e));
    const done: string[] = [];
    bg.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      done.push('slow');
    });
    bg.run(async () => {
      throw new Error('boom');
    });
    await bg.drain();
    expect(done).toEqual(['slow']);
    expect(errors).toHaveLength(1);
  });

  it('the capturing mailer remembers what was sent', async () => {
    const m = createCapturingMailer();
    await m.send({ to: 'a@b.co', subject: 's', text: 't' });
    expect(m.sent).toEqual([{ to: 'a@b.co', subject: 's', text: 't' }]);
  });
});
