import type pg from 'pg';
import { base32Decode, hotp, totpStep } from '../src/core/totp';
import type { TestApp } from './app';
import { lastTokenFor, TestClient } from './client';
import { ok } from './courses-helpers';
import { TEST_PASSWORD } from './support';

// A person with an authenticator app, for the two-factor tests. The clock is EXPLICIT: nothing here reads it twice.

export interface Clock {
  now: () => Date;
  /** back to the present (the emailed tokens are stamped by the database's real clock, so a test starts there) */
  reset(): void;
  /** move to the middle of the step `steps` later */
  tick(steps?: number): void;
  advance(seconds: number): void;
  step(): number;
}

/** Starts in the middle of the current 30-second step (the emailed tokens are stamped by the database's real clock). */
export function createClock(): Clock {
  const present = () => Math.floor(Date.now() / 30_000) * 30_000 + 15_000;
  let at = present();
  return {
    now: () => new Date(at),
    reset() {
      at = present();
    },
    tick(steps = 1) {
      at += steps * 30_000;
    },
    advance(seconds) {
      at += seconds * 1000;
    },
    step: () => totpStep(new Date(at)),
  };
}

/** The code the app shows `drift` steps from now. */
export const codeAt = (secret: string, clock: Clock, drift = 0): string =>
  hotp(base32Decode(secret), clock.step() + drift);

/** A code that is not valid anywhere near the clock. */
export const wrongCode = (secret: string, clock: Clock): string => {
  const near = new Set([-1, 0, 1].map((d) => codeAt(secret, clock, d)));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, '0');
    if (!near.has(code)) return code;
  }
};

export interface Enrolled {
  email: string;
  host: string;
  userId: string;
  secret: string;
  recoveryCodes: string[];
  /** the browser the enrolment signed in */
  browser: TestClient;
}

/** Password sign-in -> emailed link -> link + password -> first code. Needs an app with MFA_ENFORCEMENT=required. */
export async function enrol(
  t: TestApp,
  owner: pg.Pool,
  clock: Clock,
  who: { host: string; email: string },
): Promise<Enrolled> {
  const first = await new TestClient(t, who.host).login(who.email, TEST_PASSWORD);
  if (first.statusCode !== 202 || first.json().step !== 'enrol_email') {
    throw new Error(`expected the enrolment link, got ${first.statusCode} ${first.body}`);
  }
  const token = await lastTokenFor(t, who.email);
  const browser = new TestClient(t, who.host);
  const started = ok(
    await browser.post('/auth/mfa/enrol/start', { token, password: TEST_PASSWORD }),
  );
  const done = ok(
    await browser.post('/auth/mfa/enrol/confirm', { code: codeAt(started.secret, clock) }),
  );
  // the step of the confirmation code is used up
  clock.tick();
  const userId = (await owner.query('SELECT id FROM lms.users WHERE email = $1', [who.email]))
    .rows[0].id as string;
  return {
    ...who,
    userId,
    secret: started.secret,
    recoveryCodes: done.recoveryCodes,
    browser,
  };
}

/** The password step of an enrolled person: a fresh browser holding a challenge. */
export async function challenge(t: TestApp, who: { host: string; email: string }) {
  const c = new TestClient(t, who.host);
  const res = await c.login(who.email, TEST_PASSWORD);
  if (res.statusCode !== 202 || res.json().step !== 'totp') {
    throw new Error(`expected a challenge, got ${res.statusCode} ${res.body}`);
  }
  return c;
}
