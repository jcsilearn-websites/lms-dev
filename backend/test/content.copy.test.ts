import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// A large copy runs as a background job (the `content.copy` queue): the request answers 202 at once, the
// offering says `running`, the job copies in one statement and a retry after success changes nothing.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let termId: string;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp();
  A = await createAuthFixture(owner, 'cc-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  termId = (await structure(admin)).termId;
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const ctx = (attempt = 1, max = 3) => ({
  jobId: 'j',
  queue: 'content.copy',
  tenantId: A.tenantId,
  attempt,
  maxAttempts: max,
  signal: new AbortController().signal,
});

async function twoOfferings() {
  const c = await newCourse(admin);
  const src = await newOffering(admin, c.id, termId);
  const dst = await newOffering(admin, c.id, termId, { label: 'copy' });
  const teacher = await person(owner, t, A, 'Teacher');
  for (const o of [src, dst]) {
    ok(
      await admin.post(`/offerings/${o.id}/participants`, {
        userId: teacher.userId,
        participation: 'instructor',
      }),
    );
  }
  return { src, dst, teacher };
}

/** n items spread over modules of 50, written straight into the tables (the point is the size). */
async function fill(offeringId: string, items: number) {
  await owner.query(
    `WITH mods AS (
       INSERT INTO lms.content_modules (id, tenant_id, offering_id, title, position)
       SELECT gen_random_uuid(), $1, $2, 'Module ' || g, 'm' || to_char(g, 'FM0000') || 'x'
         FROM generate_series(1, ceil($3::numeric / 50)::int) g RETURNING id, position)
     INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, body, published)
     SELECT gen_random_uuid(), $1, $2, m.id, 'text', 'Item ' || i, 'i' || to_char(i, 'FM0000') || 'x',
            '{"type":"doc"}'::jsonb, true
       FROM mods m, generate_series(1, 50) i
      WHERE (ascii(substr(m.position, 2, 4)) IS NOT NULL) AND TRUE
      LIMIT $3`,
    [A.tenantId, offeringId, items],
  );
}

describe('content copy as a job', () => {
  it('a source over the inline limit is queued, marked running, and copied by the job', async () => {
    const { src, dst, teacher } = await twoOfferings();
    await fill(src.id, COPY_INLINE_LIMIT + 20);
    const r = await teacher.client.post(`/offerings/${dst.id}/copy`, { sourceOfferingId: src.id });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ status: 'queued', modules: 0, items: 0 });
    expect(ok(await teacher.client.get(`/offerings/${dst.id}`)).copyStatus).toBe('running');
    const queued = await owner.query(
      "SELECT payload FROM lms.jobs WHERE tenant_id = $1 AND queue = 'content.copy' AND status = 'queued'",
      [A.tenantId],
    );
    expect(queued.rows.some((j) => j.payload.targetId === dst.id)).toBe(true);

    // nothing was copied yet, and a second copy into the same offering is refused while it runs
    expect(ok(await teacher.client.get(`/offerings/${dst.id}/outline`)).modules).toHaveLength(0);
    const again = await teacher.client.post(`/offerings/${dst.id}/copy`, {
      sourceOfferingId: src.id,
    });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('copy_in_progress');

    // the worker runs the handler
    const payload = queued.rows.find((j) => j.payload.targetId === dst.id)?.payload;
    const handler = t.app.modules.handlers['content.copy'];
    const result = await handler?.run(payload, ctx());
    expect(result).toEqual({ modules: 11, items: COPY_INLINE_LIMIT + 20 });
    expect(ok(await teacher.client.get(`/offerings/${dst.id}`)).copyStatus).toBe('done');
    expect(ok(await teacher.client.get(`/offerings/${dst.id}/outline`)).modules).toHaveLength(11);
    // copied rows (made inside the statement) carry UUIDv7 ids
    const ids = await owner.query(
      'SELECT id::text FROM lms.content_modules WHERE offering_id = $1',
      [dst.id],
    );
    for (const r of ids.rows)
      expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // a retry after success (the first attempt crashed before it was acknowledged) copies nothing more
    const retry = await handler?.run(payload, ctx(2));
    expect(retry).toEqual({ modules: 0, items: 0 });
    expect(ok(await teacher.client.get(`/offerings/${dst.id}/outline`)).modules).toHaveLength(11);
  });

  it('a job that gives up marks the offering failed (on the last attempt only)', async () => {
    const { dst } = await twoOfferings();
    await owner.query("UPDATE lms.course_offerings SET copy_status = 'running' WHERE id = $1", [
      dst.id,
    ]);
    const handler = t.app.modules.handlers['content.copy'];
    const bad = { sourceId: dst.id, targetId: dst.id, actorUserId: 'not-a-uuid' };
    await expect(handler?.run(bad, ctx(1, 3))).rejects.toThrow();
    expect(
      (await owner.query('SELECT copy_status FROM lms.course_offerings WHERE id = $1', [dst.id]))
        .rows[0]?.copy_status,
    ).toBe('running');
    await expect(handler?.run(bad, ctx(3, 3))).rejects.toThrow();
    expect(
      (await owner.query('SELECT copy_status FROM lms.course_offerings WHERE id = $1', [dst.id]))
        .rows[0]?.copy_status,
    ).toBe('failed');
  });

  it('a source at the limit is still copied while the request waits', async () => {
    const { src, dst, teacher } = await twoOfferings();
    await fill(src.id, COPY_INLINE_LIMIT);
    const r = await teacher.client.post(`/offerings/${dst.id}/copy`, { sourceOfferingId: src.id });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'done', items: COPY_INLINE_LIMIT });
  });
});
