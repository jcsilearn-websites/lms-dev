// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { COPY_INLINE_LIMIT } from '../src/modules/content';
import { makeApp, type TestApp } from './app';
import type { TestClient } from './client';
import {
  errorCode,
  loginAs,
  newCourse,
  newOffering,
  ok,
  person,
  structure,
} from './courses-helpers';
import { blocked, hold } from './mfa-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// IDEMPOTENT OFFERING COPY (docs/system-design-review.md, follow-up P2): a double-clicked or retried copy must not append the
// content twice. The client sends a `requestKey` (as an assignment hand-in does); one key per college = one copy.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let termId: string;

beforeAll(async () => {
  owner = testOwnerPool(8);
  t = makeApp();
  A = await createAuthFixture(owner, 'ci-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  termId = (await structure(admin)).termId;
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

async function addModule(client: TestClient, offeringId: string, title: string, items: number) {
  const m = ok(await client.post(`/offerings/${offeringId}/modules`, { title }));
  for (let i = 0; i < items; i++) {
    ok(
      await client.post(`/offerings/${offeringId}/modules/${m.id}/items`, {
        kind: 'link',
        title: `${title} ${i}`,
        url: `https://example.test/${i}`,
      }),
    );
  }
}

const join = async (offeringId: string, userId: string, participation: string) =>
  ok(await admin.post(`/offerings/${offeringId}/participants`, { userId, participation }));

/** A source offering (two modules, three items) and an empty target, one instructor in both. */
async function setup() {
  const course = await newCourse(admin);
  const src = await newOffering(admin, course.id, termId);
  const dst = await newOffering(admin, course.id, termId, { label: 'copy' });
  const teacher = await person(owner, t, A, 'Teacher');
  await join(src.id, teacher.userId, 'instructor');
  await join(dst.id, teacher.userId, 'instructor');
  await addModule(teacher.client, src.id, 'One', 2);
  await addModule(teacher.client, src.id, 'Two', 1);
  const modules = async () =>
    Number(
      (
        await owner.query(
          'SELECT count(*) AS n FROM lms.content_modules WHERE offering_id = $1 AND deleted_at IS NULL',
          [dst.id],
        )
      ).rows[0].n,
    );
  const copy = (body: Record<string, unknown> = {}, client: TestClient = teacher.client) =>
    client.post(`/offerings/${dst.id}/copy`, { sourceOfferingId: src.id, ...body });
  return { course, src, dst, teacher, modules, copy };
}

describe('offering copy with a request key', () => {
  it('two identical requests AT THE SAME TIME: one copy, the same answer to both', async () => {
    const s = await setup();
    const requestKey = newId();
    const holder = await hold(owner);
    try {
      // both statements start while the target offering is locked, so each begins from a state with nothing copied
      await holder.q('SELECT 1 FROM lms.course_offerings WHERE id = $1 FOR UPDATE', [s.dst.id]);
      const both = [0, 1].map(() => Promise.resolve(s.copy({ requestKey })));
      await blocked(owner, '%course_offerings%', 2);
      await holder.commit();
      const [a, b] = await Promise.all(both);
      expect([a!.statusCode, b!.statusCode], `${a!.body}\n${b!.body}`).toEqual([200, 200]);
      expect(a!.json()).toEqual(b!.json());
      expect(a!.json()).toMatchObject({ status: 'done', modules: 2, items: 3 });
    } finally {
      await holder.commit();
    }
    expect(await s.modules()).toBe(2);
  });

  it('a retry later answers what the first call did and copies nothing; a NEW key appends again', async () => {
    const s = await setup();
    const requestKey = newId();
    const first = ok(await s.copy({ requestKey }));
    expect(ok(await s.copy({ requestKey }))).toEqual(first);
    expect(await s.modules()).toBe(2);
    ok(await s.copy({ requestKey: newId() }));
    expect(await s.modules()).toBe(4);
  });

  it('the key is required, belongs to one request, one person and the right to publish', async () => {
    const s = await setup();
    expect((await s.copy()).statusCode).toBe(400);
    const requestKey = newId();
    ok(await s.copy({ requestKey }));

    const changed = await s.copy({ requestKey, clearDates: true });
    expect([changed.statusCode, errorCode(changed)]).toEqual([409, 'request_key_reused']);
    const other = await newOffering(admin, s.course.id, termId, { label: 'other' });
    await join(other.id, s.teacher.userId, 'instructor');
    const elsewhere = await s.teacher.client.post(`/offerings/${other.id}/copy`, {
      sourceOfferingId: s.src.id,
      requestKey,
    });
    expect(errorCode(elsewhere)).toBe('request_key_reused');

    // somebody who may not copy learns nothing from a key they saw: a participant without the right is refused, and a
    // learner of a draft offering does not even see it
    const assistant = await person(owner, t, A, 'Assistant');
    await join(s.dst.id, assistant.userId, 'assistant');
    expect((await s.copy({ requestKey }, assistant.client)).statusCode).toBe(403);
    const learner = await person(owner, t, A, 'Learner');
    await join(s.dst.id, learner.userId, 'learner');
    expect((await s.copy({ requestKey }, learner.client)).statusCode).toBe(404);
    expect(await s.modules()).toBe(2);
  });

  it('a large (queued) copy retried with its key answers "queued" again and queues ONE job', async () => {
    const s = await setup();
    await addModule(s.teacher.client, s.src.id, 'Big', 1);
    // enough items to be copied by the worker
    await owner.query(
      `INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, url, completion)
       SELECT lms.uuid_v7(), m.tenant_id, m.offering_id, m.id, 'link', 'L' || g, 'i' || to_char(g, 'FM0000') || 'x',
              'https://example.test/' || g, 'manual'
         FROM lms.content_modules m, generate_series(1, $2::int) g
        WHERE m.offering_id = $1 AND m.title = 'Big'`,
      [s.src.id, COPY_INLINE_LIMIT],
    );
    const requestKey = newId();
    const first = await s.copy({ requestKey });
    expect(first.statusCode, first.body).toBe(202);
    const again = await s.copy({ requestKey });
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json()).toEqual(first.json());
    const jobs = await owner.query(
      "SELECT count(*)::int AS n FROM lms.jobs WHERE queue = 'content.copy' AND payload ->> 'targetId' = $1",
      [s.dst.id],
    );
    expect(jobs.rows[0].n).toBe(1);
  });
});
