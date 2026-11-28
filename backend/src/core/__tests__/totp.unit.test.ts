import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hotp,
  matchTotpStep,
  newTotpSecret,
  otpauthUri,
  totpStep,
} from '../totp';

// Every instant is explicit: nothing here reads the clock.
const SECRET = Buffer.from('12345678901234567890'); // the test secret of RFC 4226 / 6238
const at = (iso: string) => new Date(iso);
const atSeconds = (s: number) => new Date(s * 1000);

describe('HOTP / TOTP against the RFC vectors', () => {
  it('RFC 4226 appendix D (counters 0-9)', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expect(expected.map((_, counter) => hotp(SECRET, counter))).toEqual(expected);
  });

  it('RFC 6238 appendix B, SHA-1, 8 digits', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors) {
      expect(hotp(SECRET, totpStep(atSeconds(seconds)), 8), String(seconds)).toBe(code);
    }
  });
});

describe('the step of an instant', () => {
  it('changes exactly on the 30-second boundary', () => {
    const edge = at('2026-11-27T18:30:00.000Z');
    expect(totpStep(new Date(edge.getTime() - 1))).toBe(totpStep(edge) - 1);
    expect(totpStep(new Date(edge.getTime() + 29_999))).toBe(totpStep(edge));
    expect(totpStep(new Date(edge.getTime() + 30_000))).toBe(totpStep(edge) + 1);
  });
});

describe('drift of one step on each side, no more', () => {
  // the middle of a step
  const now = at('2026-11-27T18:30:15.000Z');
  const step = totpStep(now);

  it('accepts the previous, current and next step and returns the one that matched', () => {
    for (const s of [step - 1, step, step + 1]) {
      expect(matchTotpStep(SECRET, hotp(SECRET, s), now)).toBe(s);
    }
  });

  it('refuses two steps away', () => {
    for (const s of [step - 2, step + 2]) {
      expect(matchTotpStep(SECRET, hotp(SECRET, s), now)).toBeNull();
    }
  });

  it('a code dies the moment its step falls out of the window', () => {
    const code = hotp(SECRET, step);
    const lastValid = new Date((step + 2) * 30_000 - 1);
    expect(matchTotpStep(SECRET, code, lastValid)).toBe(step);
    expect(matchTotpStep(SECRET, code, new Date(lastValid.getTime() + 1))).toBeNull();
    const firstValid = new Date((step - 1) * 30_000);
    expect(matchTotpStep(SECRET, code, firstValid)).toBe(step);
    expect(matchTotpStep(SECRET, code, new Date(firstValid.getTime() - 1))).toBeNull();
  });

  it('refuses anything that is not six digits, and another secret', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456', '12 456']) {
      expect(matchTotpStep(SECRET, bad, now), bad).toBeNull();
    }
    expect(matchTotpStep(Buffer.from('09876543210987654321'), hotp(SECRET, step), now)).toBeNull();
  });
});

describe('base32 and the otpauth link', () => {
  it('RFC 4648 vectors (unpadded) and a round trip of random secrets', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(base32Decode(encoded).toString()).toBe(plain);
    }
    for (let i = 0; i < 20; i++) {
      const secret = newTotpSecret();
      expect(secret).toHaveLength(20);
      expect(base32Decode(base32Encode(secret))).toEqual(secret);
    }
  });

  it('escapes the account and the issuer', () => {
    expect(
      otpauthUri({ secret: SECRET, account: 'a+b@x.test', issuer: 'JCS iLearn: St. Mary' }),
    ).toBe(
      'otpauth://totp/JCS%20iLearn%3A%20St.%20Mary:a%2Bb%40x.test' +
        '?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=JCS%20iLearn%3A%20St.%20Mary' +
        '&algorithm=SHA1&digits=6&period=30',
    );
  });
});
