import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReceiptSigner } from '../deadline';
import { createKeyRing, onLegacyTokenVerified, parseSigningKeys } from '../keyring';
import { createUnsubscribeTokens } from '../mail/unsubscribe';
import { createLocalStorage } from '../storage';
import { createPlaybackTokens } from '../video';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const LEGACY = 'l'.repeat(40);
const T = '01a1e4a2-0000-7000-8000-000000000001';
const U = '01a1e4a2-0000-7000-8000-000000000002';
const now = 1_800_000_000_000;

const ring = (
  purpose: string,
  spec: string | undefined,
  legacyEnabled = true,
  legacyKey = LEGACY,
) => createKeyRing({ purpose, entries: parseSigningKeys(spec), legacyKey, legacyEnabled });

afterEach(() => onLegacyTokenVerified(null));

describe('parseSigningKeys', () => {
  it('parses an ordered list and refuses bad ids, short secrets and duplicates (without echoing secrets)', () => {
    expect(parseSigningKeys(undefined)).toEqual([]);
    expect(parseSigningKeys(`k2:${B},k1:${A}`).map((e) => e.kid)).toEqual(['k2', 'k1']);
    expect(() => parseSigningKeys(`bad id:${A}`)).toThrow(/key id/);
    expect(() => parseSigningKeys(`k1:short`)).toThrow(/32\+/);
    expect(() => parseSigningKeys(`k1:${A},k1:${B}`)).toThrow(/duplicate/);
    try {
      parseSigningKeys('k1:secret-that-is-too-short');
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-that-is-too-short');
    }
  });
});

describe('rotation, for every signed token', () => {
  const claims = { t: T, a: T, u: U, e: now / 1000 + 600 };

  it('playback: a token signed with the old key keeps working after a new key is put in front; the retired key stops', () => {
    const old = createPlaybackTokens(ring('playback', `k1:${A}`), () => now);
    const token = old.sign(claims);
    expect(token.startsWith('v2.k1.')).toBe(true);
    const rotated = createPlaybackTokens(ring('playback', `k2:${B},k1:${A}`), () => now);
    expect(rotated.verify(token)).toEqual(claims);
    expect(rotated.sign(claims).startsWith('v2.k2.')).toBe(true);
    const retired = createPlaybackTokens(ring('playback', `k2:${B}`), () => now);
    expect(retired.verify(token)).toBeNull();
    expect(retired.verify(rotated.sign(claims))).toEqual(claims);
  });

  it('a token of one purpose is never valid for another, even with the same secrets', () => {
    const spec = `k1:${A}`;
    const playback = createPlaybackTokens(ring('playback', spec), () => now);
    const token = playback.sign(claims);
    // the same shape, signed for another purpose, is refused
    const receipts = createReceiptSigner({
      key: ring('receipt', spec),
      windowSeconds: 60,
      now: () => now,
    });
    expect(receipts.verify(token)).toBeNull();
  });

  it('receipts and unsubscribe tokens rotate the same way', () => {
    const r1 = createReceiptSigner({
      key: ring('receipt', `k1:${A}`),
      windowSeconds: 600,
      now: () => now,
    });
    const receipt = r1.sign({ u: U, t: T, s: 's', r: 'r', o: 'o', h: 'h', a: now });
    const r2 = createReceiptSigner({
      key: ring('receipt', `k2:${B},k1:${A}`),
      windowSeconds: 600,
      now: () => now,
    });
    expect(r2.verify(receipt)?.r).toBe('r');
    const u1 = createUnsubscribeTokens(ring('unsubscribe', `k1:${A}`), {
      ttlSeconds: 3600,
      now: () => now,
    });
    const tok = u1.sign({ tenantId: T, userId: U, category: 'learning_grades' });
    const u2 = createUnsubscribeTokens(ring('unsubscribe', `k2:${B},k1:${A}`), {
      ttlSeconds: 3600,
      now: () => now,
    });
    expect(u2.verify(tok)).toMatchObject({ ok: true });
    const u3 = createUnsubscribeTokens(ring('unsubscribe', `k2:${B}`), {
      ttlSeconds: 3600,
      now: () => now,
    });
    expect(u3.verify(tok)).toMatchObject({ ok: false, reason: 'forged' });
  });

  it('storage URLs rotate and an unknown key id is refused', () => {
    const mk = (spec: string) =>
      createLocalStorage({
        dir: '.',
        secret: ring('storage', spec),
        ttlSeconds: 60,
        now: () => now,
      });
    const key = `${T}/${U}`;
    const target = mk(`k1:${A}`).createDownloadTarget({
      key,
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      inline: true,
    });
    const token = target.url.split('/').pop() ?? '';
    expect(mk(`k2:${B},k1:${A}`).verify(token, 'get')?.k).toBe(key);
    expect(mk(`k2:${B}`).verify(token, 'get')).toBeNull();
    const swapped = token.replace('v2.k1.', 'v2.k9.');
    expect(mk(`k2:${B},k1:${A}`).verify(swapped, 'get')).toBeNull();
  });
});

describe('legacy (unversioned) tokens', () => {
  const claims = { t: T, a: T, u: U, e: now / 1000 + 600 };
  // a playback token exactly as the code before key ids signed it
  const legacyToken = () => {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const mac = createHmac('sha256', LEGACY)
      .update('lms.video.playback.v1')
      .update('.')
      .update(payload)
      .digest('base64url');
    return `${payload}.${mac}`;
  };

  it('still verify while enabled (with or without SIGNING_KEYS), and each acceptance is counted', () => {
    const seen = vi.fn();
    onLegacyTokenVerified(seen);
    for (const spec of [undefined, `k1:${A}`]) {
      const tokens = createPlaybackTokens(ring('playback', spec), () => now);
      expect(tokens.verify(legacyToken())).toEqual(claims);
    }
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenCalledWith('playback');
  });

  it('are refused once the flag is off, and a v2 token is not counted', () => {
    const seen = vi.fn();
    onLegacyTokenVerified(seen);
    const off = createPlaybackTokens(ring('playback', `k1:${A}`, false), () => now);
    expect(off.verify(legacyToken())).toBeNull();
    expect(seen).not.toHaveBeenCalled();
    const on = createPlaybackTokens(ring('playback', `k1:${A}`), () => now);
    expect(on.verify(on.sign(claims))).toEqual(claims);
    expect(seen).not.toHaveBeenCalled();
  });

  it('a legacy unsubscribe token (v1.<payload>.<mac>) verifies', () => {
    const payload = Buffer.from(
      JSON.stringify({ t: T, u: U, c: 'learning_grades', e: now / 1000 + 100 }),
    ).toString('base64url');
    const mac = createHmac('sha256', LEGACY).update(`v1.${payload}`).digest('base64url');
    const tokens = createUnsubscribeTokens(ring('unsubscribe', `k1:${A}`), {
      ttlSeconds: 60,
      now: () => now,
    });
    expect(tokens.verify(`v1.${payload}.${mac}`)).toMatchObject({ ok: true });
    expect(tokens.verify(`v1.${payload}.${mac.slice(0, -1)}A`)).toMatchObject({ ok: false });
  });
});
