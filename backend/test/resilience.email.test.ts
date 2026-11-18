import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { deliverEmails } from './client';
import { type Person, person } from './courses-helpers';
import { outboxOf, quietOff } from './notifications-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 14a: the email provider is DOWN. The outbox backs up, the circuit breaker stops the calls (a handful of probes instead of
// one timed-out call per email), the jobs are DEFERRED with no attempt charged (nothing dead-letters, however long the outage), and
// when the provider is back everything is sent exactly once. The "10 minutes" are simulated: the breaker's clock is covered by
// core/__tests__/resilience.unit.test.ts; here the cooldown is one second and the jobs' run_at is moved with SQL, like the other
// email tests do.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
const people: Person[] = [];
const N = 12;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({
    env: {
      EMAIL_BREAKER_FAILURES: '3',
      EMAIL_BREAKER_COOLDOWN_SECONDS: '1',
      EMAIL_FROM_DEFAULT: 'no-reply@notify.example.test',
    },
  });
  A = await createAuthFixture(owner, 'res-m');
  await t.app.ready();
  await quietOff(owner, A.tenantId);
  for (let i = 0; i < N; i++) people.push(await person(owner, t, A, `Down${i}`));
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const enqueue = (p: Person, key: string) =>
  owner.query(
    `SELECT lms.notify_fanout(ARRAY[ROW($1::uuid, $2::uuid, 'learning_content', 'content_digest',
       jsonb_build_object('course', 'Physics', 'count', 1, 'titles', jsonb_build_array('Lab 1')),
       '/offerings/x', $3::text, 'content_digest', NULL::timestamptz, true)::lms.notify_item])`,
    [A.tenantId, p.userId, key],
  );
const makeDue = () =>
  owner.query(
    `UPDATE lms.jobs SET run_at = now() WHERE queue = 'email.send' AND status = 'queued'`,
  );

describe('the provider is down, then back', () => {
  it('backs up without dead letters or wasted calls, then drains with every email sent exactly once', async () => {
    for (const [i, p] of people.entries()) await enqueue(p, `outage-${i}`);
    // the provider fails every call from now on (a count far above what the breaker will allow through)
    t.mailer.failNext(10_000, new Error('connect ECONNREFUSED provider'));

    // several delivery rounds while it is down
    for (let round = 0; round < 3; round++) {
      await makeDue();
      await deliverEmails(t);
    }
    const downCalls = t.mailer.calls;
    // 3 failures open the circuit; afterwards only one probe per cooldown. Without the breaker: 12 emails x 3 rounds = 36 calls.
    expect(downCalls).toBeLessThan(12);
    expect(t.mailer.sent).toHaveLength(0);

    // nothing is lost: every row is waiting, none is dead, and no job consumed an attempt it will miss later
    const rows = await owner.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM lms.email_outbox WHERE tenant_id = $1 GROUP BY status`,
      [A.tenantId],
    );
    expect(Object.fromEntries(rows.rows.map((r) => [r.status, Number(r.n)]))).toEqual({
      queued: N,
    });
    const jobs = await owner.query<{ status: string; attempts: number; max_attempts: number }>(
      `SELECT status, attempts, max_attempts FROM lms.jobs WHERE queue = 'email.send' AND tenant_id = $1`,
      [A.tenantId],
    );
    expect(jobs.rows.every((j) => j.status === 'queued')).toBe(true);
    // the breaker defers WITHOUT charging: the attempts left are the ones a real failure would have used
    expect(Math.max(...jobs.rows.map((j) => j.attempts))).toBeLessThan(
      Math.min(...jobs.rows.map((j) => j.max_attempts)),
    );
    // the backlog is visible on the operations gauge
    const gauge = await t.app.modules.ops.service.rows();
    expect(
      gauge.find((r) => r.metric === 'email_outbox_backlog' && r.label === 'queued')?.value,
    ).toBeGreaterThanOrEqual(N);

    // the provider comes back; the cooldown passes
    t.mailer.failNext(0);
    await new Promise((r) => setTimeout(r, 1100));
    for (let round = 0; round < 3; round++) {
      await makeDue();
      await deliverEmails(t);
    }
    const sentTo = t.mailer.sent.map((m) => m.to).sort();
    expect(sentTo).toEqual(people.map((p) => p.email).sort()); // every recipient exactly once
    for (const p of people)
      expect((await outboxOf(owner, { userId: p.userId }))[0]?.status).toBe('sent');
    // and a further round sends nothing again
    await makeDue();
    await deliverEmails(t);
    expect(t.mailer.sent).toHaveLength(N);
  });
});
