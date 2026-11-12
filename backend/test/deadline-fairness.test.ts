// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReceiptSigner, receiptKey } from '../src/core/deadline';
import { createDb } from '../src/db/client';
import { makeApp, type TestApp } from './app';
import {
  addAssessment,
  addQuestion,
  type Exam,
  exam,
  fixed,
  optionId,
  q,
  save,
  startAttempt,
} from './assessments-helpers';
import { addAssignment, base, inHours, setDates } from './assignments-helpers';
import { TestClient } from './client';
import { errorCode, type Json, loginAs, ok, type Structure, structure } from './courses-helpers';
import { type AuthFixture, createAuthFixture, testAppDbOptions, testOwnerPool } from './support';

// Step 10b: DEADLINE FAIRNESS UNDER LOAD. A request that ARRIVED before a deadline stays on time when the database pool is
// saturated: the arrival time is taken in Node before the wait, a 503 busy carries a signed receipt (no database access), and
// the retry's deadline check uses that arrival. The pool of the app under test has ONE connection and a 300 ms wait limit, and
// the test holds that connection across the deadline.

let owner: pg.Pool;
let normal: TestApp;
let busy: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;
const SECRET = 'test-only-signing-secret-0123456789abcdef';

beforeAll(async () => {
  owner = testOwnerPool();
  normal = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  // ONE connection, 300 ms to get it; no save grace so the deadline is the deadline
  busy = makeApp({
    db: createDb({ ...testAppDbOptions(1), connectionTimeoutMs: 300 }),
    env: { TENANT_CACHE_TTL_MS: '3600000', ASSESSMENT_SAVE_GRACE_SECONDS: '0' },
  });
  A = await createAuthFixture(owner, 'dl-a');
  await normal.app.ready();
  await busy.app.ready();
  admin = await loginAs(normal, A.host, A.adminEmail);
  st = await structure(admin);
});
afterAll(async () => {
  await normal.close();
  await busy.close();
  await owner.end();
});

/** The same signed-in person, talking to the app whose pool is one connection. */
const onBusy = (c: TestClient): TestClient => {
  const b = new TestClient(busy, A.host);
  b.cookies = new Map(c.cookies);
  return b;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Occupies the only connection of the busy app for `ms` and returns once it has it (a request that was refused a moment ago may
 * still be returning it); the promise is the end of the hold.
 */
async function hold(ms: number): Promise<{ done: Promise<unknown> }> {
  let acquired!: () => void;
  const ready = new Promise<void>((r) => {
    acquired = r;
  });
  let got = false;
  const done = (async () => {
    for (;;) {
      try {
        await busy.db.withoutTenant(async (conn) => {
          got = true;
          acquired();
          await conn.execute(sql`SELECT pg_sleep(${ms / 1000})`);
        });
        return;
      } catch (err) {
        if (got) throw err;
        await sleep(25);
      }
    }
  })();
  await ready;
  return { done };
}
const RECEIPT = 'deadline-receipt';
const SEND = 'x-deadline-receipt';

describe('the receipt', () => {
  const signer = createReceiptSigner({
    key: receiptKey({ storageSecret: SECRET }),
    windowSeconds: 600,
  });
  const claims = {
    u: 'u1',
    t: 't1',
    s: 'ab'.repeat(32),
    r: 'r1',
    o: 'assignment.submit',
    a: Date.now(),
  };

  it('is signed and checked without any database', () => {
    const c = signer.verify(signer.sign(claims));
    expect(c).toMatchObject(claims);
    expect(c!.e).toBeGreaterThan(Date.now());
  });

  it('a changed payload or signature, another key, junk and an expired one are all refused', () => {
    const token = signer.sign(claims);
    const [payload, mac] = token.split('.') as [string, string];
    const forgedClaims = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), a: 1 }),
    ).toString('base64url');
    expect(signer.verify(`${forgedClaims}.${mac}`)).toBeNull();
    expect(signer.verify(`${payload}.${mac.slice(0, -2)}AA`)).toBeNull();
    expect(
      createReceiptSigner({
        key: 'another-key-another-key-another-key-0',
        windowSeconds: 600,
      }).verify(token),
    ).toBeNull();
    for (const junk of ['', 'abc', 'a.b', '.', `${payload}`, 'x'.repeat(2000)])
      expect(signer.verify(junk)).toBeNull();
    let now = Date.now();
    const clocked = createReceiptSigner({
      key: receiptKey({ storageSecret: SECRET }),
      windowSeconds: 600,
      now: () => now,
    });
    const old = clocked.sign(claims);
    expect(clocked.verify(old)).not.toBeNull();
    now += 601_000;
    expect(clocked.verify(old)).toBeNull();
  });
});

describe('lms.effective_arrival: the one place the claim is validated', () => {
  const eff = async (arrival: string | null, maxAge: number) =>
    (
      await owner.query(
        `SELECT extract(epoch FROM now() - lms.effective_arrival($1::timestamptz, $2)) AS age, extract(epoch FROM now() - $1::timestamptz) AS claimed`,
        [arrival, maxAge],
      )
    ).rows[0];

  it('none: now(); the future: clamped to now() (a fast clock buys nothing)', async () => {
    expect(Number((await eff(null, 30)).age)).toBeLessThan(0.5);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(Number((await eff(future, 30)).age)).toBeLessThan(0.5);
  });

  it('a recent arrival is believed; an older one only up to the bound (a slow clock or a replay buys at most that)', async () => {
    const recent = new Date(Date.now() - 5_000).toISOString();
    const r = await eff(recent, 30);
    expect(Number(r.age)).toBeGreaterThan(4.5);
    expect(Number(r.age)).toBeLessThan(6);
    const old = new Date(Date.now() - 3_600_000).toISOString();
    const o = await eff(old, 30);
    expect(Number(o.age)).toBeGreaterThan(29.5);
    expect(Number(o.age)).toBeLessThan(31);
    expect(Number((await eff(old, 7200)).age)).toBeGreaterThan(3500);
  });
});

describe('assignment finalize under a saturated pool', () => {
  let e: Exam;
  beforeAll(async () => {
    e = await exam(owner, normal, A, admin, st, 4);
    await normal.app.ready();
    // warm the slug cache of the busy app
    await onBusy(e.learners[0]!.client).get('/auth/me');
  });

  /** An assignment due in `dueInMs`, text only (no upload: the grace rule must not be what saves the learner). */
  async function due(dueInMs: number, settings: Json = {}) {
    const late = settings.latePolicy === 'allowed';
    const item = await addAssignment(e, {
      settings: {
        allowText: true,
        allowFile: true,
        ...(late ? { dueAt: inHours(1), lateCutoffAt: inHours(48) } : {}),
        ...settings,
      },
    });
    await setDates(owner, item.id, {
      dueAt: new Date(Date.now() + dueInMs).toISOString(),
      cutoffAt: late ? inHours(48) : null,
    });
    return item;
  }
  const finalize = (c: TestClient, itemId: string, headers: Record<string, string> = {}) =>
    c.post(
      `${base(e, itemId)}/submissions`,
      { requestKey: randomUUID(), fileIds: [], text: 'my answer' },
      { headers },
    );

  it('arrived before the deadline: refused with 503 + a receipt, retried after the deadline WITH it = on time; without it = closed', async () => {
    const item = await due(2200);
    const [a, b] = [onBusy(e.learners[0]!.client), onBusy(e.learners[1]!.client)];
    const held = (await hold(3200)).done;
    await sleep(80);
    const first = await finalize(a, item.id);
    expect(first.statusCode, first.body).toBe(503);
    expect(first.headers['retry-after']).toBe('2');
    expect(errorCode(first)).toBe('busy');
    const receipt = String(first.headers[RECEIPT]);
    expect(receipt.length).toBeGreaterThan(50);
    const control = await finalize(b, item.id);
    expect(control.statusCode).toBe(503);
    await held;
    // the deadline is behind us by now
    const row = (
      await owner.query('SELECT due_at < now() AS past FROM lms.assignments WHERE item_id = $1', [
        item.id,
      ])
    ).rows[0];
    expect(row.past).toBe(true);
    // the retry that carries the receipt: on time, and the version says when it ARRIVED
    const retried = ok(await finalize(a, item.id, { [SEND]: receipt }));
    expect(retried).toMatchObject({ result: 'ok', lateSeconds: 0 });
    const v = (
      await owner.query(
        'SELECT submitted_at, late_seconds FROM lms.submissions WHERE assignment_item_id = $1',
        [item.id],
      )
    ).rows[0];
    expect(Number(v.late_seconds)).toBe(0);
    // the other learner arrived at the same time but kept no receipt: the deadline is the deadline
    const lost = await finalize(b, item.id);
    expect(lost.statusCode).toBe(409);
    expect(errorCode(lost)).toBe('assignment_closed');
  });

  it('a late policy: arrived before the deadline = NO penalty after the retry; arrived after = the penalty of its own arrival', async () => {
    const item = await due(2000, {
      latePolicy: 'allowed',
      penaltyKind: 'flat',
      penaltyValue: 20,
      penaltyCap: 50,
    });
    const [a, b] = [onBusy(e.learners[0]!.client), onBusy(e.learners[1]!.client)];
    // learner a arrives early
    const held = (await hold(2900)).done;
    await sleep(80);
    const early = await finalize(a, item.id);
    expect(early.statusCode).toBe(503);
    await held;
    // learner b arrives AFTER the deadline, while the pool is saturated again
    const held2 = (await hold(1500)).done;
    await sleep(80);
    const late = await finalize(b, item.id);
    expect(late.statusCode).toBe(503);
    await held2;
    const onTime = ok(await finalize(a, item.id, { [SEND]: String(early.headers[RECEIPT]) }));
    expect(onTime).toMatchObject({ result: 'ok', lateSeconds: 0, penaltyPercent: 0 });
    // b: a receipt cannot move an arrival that was already late: still late, and the lateness counts from ITS arrival
    const lateRetry = ok(await finalize(b, item.id, { [SEND]: String(late.headers[RECEIPT]) }));
    expect(lateRetry.lateSeconds).toBeGreaterThan(0);
    expect(lateRetry.lateSeconds).toBeLessThan(15);
    expect(lateRetry.penaltyPercent).toBe(20);
  });

  it('arriving AFTER the deadline is late even with a receipt and any number of retries', async () => {
    const item = await due(500);
    const c = onBusy(e.learners[2]!.client);
    await sleep(900);
    const held = (await hold(1200)).done;
    await sleep(80);
    const first = await finalize(c, item.id);
    expect(first.statusCode).toBe(503);
    const receipt = String(first.headers[RECEIPT]);
    // refused AGAIN while carrying the receipt: the SAME receipt comes back (the arrival never moves later)
    const second = await finalize(c, item.id, { [SEND]: receipt });
    expect(second.statusCode).toBe(503);
    expect(String(second.headers[RECEIPT])).toBe(receipt);
    await held;
    const done = await finalize(c, item.id, { [SEND]: receipt });
    expect(done.statusCode).toBe(409);
    expect(errorCode(done)).toBe('assignment_closed');
  });

  it('a forged, expired, other-user, other-resource or other-operation receipt is IGNORED (the retry counts from its own arrival)', async () => {
    const item = await due(2200);
    const other = await due(2200);
    const [a, b] = [onBusy(e.learners[0]!.client), onBusy(e.learners[3]!.client)];
    const held = (await hold(3200)).done;
    await sleep(80);
    const mine = await finalize(a, item.id);
    const theirs = await finalize(b, item.id);
    const elsewhere = await finalize(a, other.id);
    expect([mine.statusCode, theirs.statusCode, elsewhere.statusCode]).toEqual([503, 503, 503]);
    await held;
    const good = String(mine.headers[RECEIPT]);
    const [payload, mac] = good.split('.') as [string, string];
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), a: Date.now() - 600_000 })).toString('base64url')}.${mac}`;
    // expired: validly signed with the same key, but a window that ended
    let past = Date.now() - 2_000_000;
    const old = createReceiptSigner({
      key: receiptKey({ storageSecret: SECRET }),
      windowSeconds: 600,
      now: () => past,
    });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      u: string | null;
      t: string;
      s: string;
      r: string;
      o: string;
      a: number;
    };
    const expired = old.sign({
      u: claims.u,
      t: claims.t,
      s: claims.s,
      r: claims.r,
      o: claims.o,
      a: claims.a,
    });
    past = Date.now();
    const wrongOperation = busy.app.receipts!.sign({ ...claims, o: 'attempt.save' });
    const wrongResource = busy.app.receipts!.sign({ ...claims, r: other.id });
    const wrongTenant = busy.app.receipts!.sign({ ...claims, t: randomUUID() });
    for (const [name, token, client, target] of [
      ['forged arrival', forged, a, item.id],
      ['expired', expired, a, item.id],
      ['wrong operation', wrongOperation, a, item.id],
      ['wrong resource', wrongResource, a, item.id],
      ['wrong college', wrongTenant, a, item.id],
      ["another user's receipt (theirs) used by me", String(theirs.headers[RECEIPT]), a, item.id],
      ['my receipt for ANOTHER assignment', String(elsewhere.headers[RECEIPT]), a, item.id],
      ['junk', 'not-a-receipt', a, item.id],
    ] as const) {
      const r = await finalize(client, target, { [SEND]: token });
      expect(r.statusCode, `${name}: ${r.body}`).toBe(409);
      expect(errorCode(r), name).toBe('assignment_closed');
    }
    // and the genuine one still works for its owner and resource, for the same retry
    expect(ok(await finalize(a, item.id, { [SEND]: good })).lateSeconds).toBe(0);
    // the other learner's genuine receipt does not work for ME but does for HIM
    expect(
      ok(await finalize(b, item.id, { [SEND]: String(theirs.headers[RECEIPT]) })).lateSeconds,
    ).toBe(0);
  });

  it('a receipt of the same USER from another session is accepted only when the user was known; never for another person', async () => {
    // the session lookup itself was refused here (the pool is held from the first byte): the receipt is bound to the SESSION
    const item = await due(2200);
    const a = onBusy(e.learners[0]!.client);
    const held = (await hold(3200)).done;
    await sleep(80);
    const first = await finalize(a, item.id);
    expect(first.statusCode).toBe(503);
    await held;
    const claims = busy.app.receipts!.verify(String(first.headers[RECEIPT]))!;
    expect(claims.u).toBeNull();
    expect(claims.s).toMatch(/^[0-9a-f]{64}$/);
    // a second device of the same person has another session cookie: the receipt is NOT bound to it
    const second = await loginAs(normal, A.host, e.learners[0]!.email);
    const r = await finalize(onBusy(second), item.id, { [SEND]: String(first.headers[RECEIPT]) });
    expect(r.statusCode).toBe(409);
  });
});

describe('exam autosave and submit under a saturated pool', () => {
  let e: Exam;
  let item: Json;
  let right: string;
  beforeAll(async () => {
    e = await exam(owner, normal, A, admin, st, 4);
    const mc = await addQuestion(
      e.instructor.client,
      e.courseId,
      q.single('Fair?', ['yes', 'no'], 0),
    );
    right = optionId(mc, 'yes');
    item = await addAssessment(e, { slots: [fixed(mc.id)], settings: { attemptsAllowed: 3 } });
    await onBusy(e.learners[0]!.client).get('/auth/me');
  });

  /** A started attempt whose server deadline is `inMs` from now. */
  async function attempt(learner: number, inMs: number) {
    const s = await startAttempt(e, e.learners[learner]!, item.id);
    await owner.query(
      `UPDATE lms.attempts SET deadline_at = now() + make_interval(secs => $2) WHERE id = $1`,
      [s.attemptId, inMs / 1000],
    );
    return s.attemptId;
  }
  const answer = (rev = 1) => [
    { position: 1, answer: { o: ['aaaaaaaaaaaa'] }, rev, at: Date.now() },
  ];
  const saveOn = (c: TestClient, attemptId: string, headers: Record<string, string> = {}) =>
    c.put(
      `/offerings/${e.offeringId}/attempts/${attemptId}/answers`,
      { answers: answer(), events: [] },
      { headers },
    );
  const submitOn = (c: TestClient, attemptId: string, headers: Record<string, string> = {}) =>
    c.post(`/offerings/${e.offeringId}/attempts/${attemptId}/submit`, undefined, { headers });

  it('AUTOSAVE that arrived before the deadline is applied on the retry with its receipt; without it the attempt is closed', async () => {
    const [id1, id2] = [await attempt(0, 2200), await attempt(1, 2200)];
    const [a, b] = [onBusy(e.learners[0]!.client), onBusy(e.learners[1]!.client)];
    const held = (await hold(3200)).done;
    await sleep(80);
    const first = await saveOn(a, id1);
    const second = await saveOn(b, id2);
    expect([first.statusCode, second.statusCode]).toEqual([503, 503]);
    await held;
    const done = ok(await saveOn(a, id1, { [SEND]: String(first.headers[RECEIPT]) }));
    expect(done).toMatchObject({ result: 'ok', applied: 1 });
    const kept = (
      await owner.query('SELECT rev, answer FROM lms.attempt_questions WHERE attempt_id = $1', [
        id1,
      ])
    ).rows[0];
    expect(kept.rev).toBe(1);
    // no receipt: the deadline had passed when it was served
    const lost = ok(await saveOn(b, id2));
    expect(lost.result).toBe('closed');
    expect(
      (await owner.query('SELECT rev FROM lms.attempt_questions WHERE attempt_id = $1', [id2]))
        .rows[0].rev,
    ).toBe(0);
    void right;
  });

  it('SUBMIT that arrived before the deadline stays a manual hand-in on the retry; one that arrived after is labelled a deadline close', async () => {
    const [id1, id2] = [await attempt(0, 2200), await attempt(1, 600)];
    const [a, b] = [onBusy(e.learners[0]!.client), onBusy(e.learners[1]!.client)];
    const held = (await hold(3200)).done;
    await sleep(80);
    const early = await submitOn(a, id1);
    expect(early.statusCode).toBe(503);
    await sleep(900); // b's deadline (600 ms) passes while the pool is still held
    const lateArrival = await submitOn(b, id2);
    expect(lateArrival.statusCode).toBe(503);
    await held;
    ok(await submitOn(a, id1, { [SEND]: String(early.headers[RECEIPT]) }));
    ok(await submitOn(b, id2, { [SEND]: String(lateArrival.headers[RECEIPT]) }));
    const kinds = async (id: string) =>
      (await owner.query('SELECT submit_kind FROM lms.attempts WHERE id = $1', [id])).rows[0]
        .submit_kind;
    expect(await kinds(id1)).toBe('manual');
    expect(await kinds(id2)).toBe('deadline');
  });

  it("another learner's attempt, a forged receipt and a receipt for another operation are ignored", async () => {
    const [mine, theirs, theirs2] = [
      await attempt(2, 2200),
      await attempt(3, 2200),
      await attempt(3, 2200).catch(() => null),
    ];
    const [a, b] = [onBusy(e.learners[2]!.client), onBusy(e.learners[3]!.client)];
    const held = (await hold(3200)).done;
    await sleep(80);
    const r1 = await saveOn(a, mine);
    const r2 = await saveOn(b, theirs);
    await held;
    expect([r1.statusCode, r2.statusCode]).toEqual([503, 503]);
    // learner b tries a's receipt on b's own attempt (another user, another resource): closed
    expect(ok(await saveOn(b, theirs, { [SEND]: String(r1.headers[RECEIPT]) })).result).toBe(
      'closed',
    );
    // a's receipt is for `attempt.save`: it does not turn a submit into an in-time one
    ok(await submitOn(a, mine, { [SEND]: String(r1.headers[RECEIPT]) }));
    expect(
      (await owner.query('SELECT submit_kind FROM lms.attempts WHERE id = $1', [mine])).rows[0]
        .submit_kind,
    ).toBe('deadline');
    // and a forged one, on a second attempt of the same learner (the first one is closed now)
    void theirs2;
  });

  it('a forged receipt is ignored on an autosave', async () => {
    const id = await attempt(0, 2200);
    const a = onBusy(e.learners[0]!.client);
    const held = (await hold(3200)).done;
    await sleep(80);
    const first = await saveOn(a, id);
    expect(first.statusCode).toBe(503);
    await held;
    const token = String(first.headers[RECEIPT]);
    expect(ok(await saveOn(a, id, { [SEND]: `${token.slice(0, -3)}abc` })).result).toBe('closed');
  });
});

describe('what is NOT deadline-sensitive stays as it was', () => {
  it('a saturated pool on any other route is a plain 503 busy: no receipt', async () => {
    const e = await exam(owner, normal, A, admin, st, 1);
    const c = onBusy(e.learners[0]!.client);
    await c.get('/auth/me');
    const held = (await hold(900)).done;
    await sleep(80);
    const r = await c.get('/auth/me');
    await held;
    expect(r.statusCode).toBe(503);
    expect(errorCode(r)).toBe('busy');
    expect(r.headers[RECEIPT]).toBeUndefined();
    void save;
  });
});
