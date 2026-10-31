import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { createProgressRepository, createProgressService } from '../src/modules/progress';
import { makeApp, type TestApp } from './app';
import type { TestClient } from './client';
import {
  doc,
  errorCode,
  type Json,
  loginAs,
  newCourse,
  newOffering,
  ok,
  type Person,
  person,
  type Structure,
  structure,
  student,
} from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 8: learning progress. Unique watched seconds (the database merges them), the integrity rules, completion rules,
// required / optional items, the archive-instead-of-delete rule, visibility, the class views and the CSV export.
// Round-trip budgets are at the end.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let adminB: TestClient;
let st: Structure;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'pg-a');
  B = await createAuthFixture(owner, 'pg-b');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  adminB = await loginAs(t, B.host, B.adminEmail);
  st = await structure(admin);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

interface Course {
  offeringId: string;
  moduleId: string;
  instructor: Person;
  assistant: Person;
  learner: Person;
  videoId: string;
  videoItem: Json;
  textItem: Json;
  linkItem: Json;
  optionalItem: Json;
}

/** A ready video of `seconds` seconds (the transcode is not what is tested here). */
async function readyVideo(offeringId: string, createdBy: string, seconds = 100): Promise<string> {
  const id = newId();
  await owner.query(
    `INSERT INTO lms.video_assets (id, tenant_id, offering_id, created_by, original_name, declared_size, status,
                                   duration_ms, hls_prefix, ready_at, upload_offset, progress, renditions)
     VALUES ($1, $2, $3, $4, 'p.mp4', 1000, 'ready', $5, 'x', now(), 1000, 100, '[]'::jsonb)`,
    [id, A.tenantId, offeringId, createdBy, seconds * 1000],
  );
  return id;
}

/** An offering with an instructor, an assistant and a learner, and four published items in one published module. */
async function course(): Promise<Course> {
  const c = await newCourse(admin);
  const o = await newOffering(admin, c.id, st.termId);
  const instructor = await person(owner, t, A, 'Instructor');
  const assistant = await person(owner, t, A, 'Assistant');
  const learner = await person(owner, t, A, 'Learner');
  for (const [p, participation] of [
    [instructor, 'instructor'],
    [assistant, 'assistant'],
    [learner, 'learner'],
  ] as const) {
    ok(await admin.post(`/offerings/${o.id}/participants`, { userId: p.userId, participation }));
  }
  ok(await instructor.client.post(`/offerings/${o.id}/publish`));
  const m = ok(await instructor.client.post(`/offerings/${o.id}/modules`, { title: 'Week 1' }));
  ok(await instructor.client.patch(`/offerings/${o.id}/modules/${m.id}`, { published: true }));
  const videoId = await readyVideo(o.id, instructor.userId);
  const add = async (body: Json) =>
    ok(
      await instructor.client.post(`/offerings/${o.id}/modules/${m.id}/items`, {
        published: true,
        ...body,
      }),
    );
  return {
    offeringId: o.id,
    moduleId: m.id,
    instructor,
    assistant,
    learner,
    videoId,
    videoItem: await add({ kind: 'video', title: 'Lecture', videoId }),
    textItem: await add({ kind: 'text', title: 'Notes', body: doc('hello') }),
    linkItem: await add({ kind: 'link', title: 'Reading', url: 'https://example.org/r' }),
    optionalItem: await add({ kind: 'text', title: 'Extra', body: doc('more'), required: false }),
  };
}

const beat = (
  p: Person,
  c: Course,
  item: Json,
  b: {
    ranges: [number, number][];
    seq: number;
    stream?: string;
    position?: number;
    rate?: number;
    videoId?: string;
  },
) =>
  p.client.post(`/offerings/${c.offeringId}/items/${item.id}/progress/heartbeat`, {
    videoId: b.videoId ?? c.videoId,
    streamId: b.stream ?? STREAM_A,
    seq: b.seq,
    ranges: b.ranges,
    position: b.position ?? b.ranges.at(-1)?.[1] ?? 0,
    rate: b.rate ?? 1,
  });
const STREAM_A = '0a000000-0000-7000-8000-00000000000a';
const STREAM_B = '0b000000-0000-7000-8000-00000000000b';

/** Gives the learner's bucket `seconds` of room (it normally refills at 2x real time). */
const refill = (_c: Course, item: Json, seconds: number) =>
  owner.query(`UPDATE lms.item_progress SET budget_s = $2, budget_at = now() WHERE item_id = $1`, [
    item.id,
    seconds,
  ]);
const row = async (item: Json) =>
  (await owner.query('SELECT * FROM lms.item_progress WHERE item_id = $1', [item.id])).rows[0];
const mine = async (c: Course, p = c.learner) =>
  ok(await p.client.get(`/offerings/${c.offeringId}/progress`));
const statusOf = (m: Json, item: Json) => m.items.find((i: Json) => i.itemId === item.id)?.status;

// ---------------------------------------------------------------------------------------------------
describe('video: unique watched seconds', () => {
  it('counts what was played, merges overlaps, and never counts a second twice', async () => {
    const c = await course();
    const first = ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 30]], seq: 1 }));
    expect(first).toMatchObject({
      result: 'ok',
      watchedSeconds: 30,
      durationSeconds: 100,
      percent: 30,
      completed: false,
    });
    // (a real player sends one every 30 s: give the bucket the time it would have had)
    await refill(c, c.videoItem, 600);
    // an overlapping range adds only what is new
    const second = ok(await beat(c.learner, c, c.videoItem, { ranges: [[20, 50]], seq: 2 }));
    expect(second.watchedSeconds).toBe(50);
    // watching the same part again adds nothing
    expect(
      ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 30]], seq: 3 })).watchedSeconds,
    ).toBe(50);
    const r = await row(c.videoItem);
    expect(r.ranges).toBe('{[0,50)}');
    expect(r.suspicious).toBe(0);
  });

  it('seeking forward adds no watched time: only played ranges count, and gaps stay gaps', async () => {
    const c = await course();
    ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 10]], seq: 1 }));
    // jumped to 80, played 5 seconds; the position moves, the coverage does not jump
    const r = ok(
      await beat(c.learner, c, c.videoItem, { ranges: [[80, 85]], seq: 2, position: 85 }),
    );
    expect(r.watchedSeconds).toBe(15);
    expect(r.positionSeconds).toBe(85);
    expect((await row(c.videoItem)).ranges).toBe('{[0,10),[80,85)}');
  });

  it('rounds inward: a second counts only when it was played completely', async () => {
    const c = await course();
    const r = ok(await beat(c.learner, c, c.videoItem, { ranges: [[0.4, 10.6]], seq: 1 }));
    expect(r.watchedSeconds).toBe(9); // seconds 1..9 were played completely
    expect((await row(c.videoItem)).ranges).toBe('{[1,10)}');
  });

  it('cuts a claim that is physically impossible: the earliest seconds are kept and it is counted, not reported', async () => {
    const c = await course();
    // a fresh bucket holds 45 s: 80 s claimed in one go
    const r = ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 80]], seq: 1 }));
    expect(r.watchedSeconds).toBe(45);
    const p = await row(c.videoItem);
    expect(p.ranges).toBe('{[0,45)}');
    expect(p.suspicious).toBe(1);
    // no error status for the learner: a 200 like any other
    // 2x speed is fine: 30 seconds of real time play 60 seconds of video
    await refill(c, c.videoItem, 0);
    await owner.query(
      "UPDATE lms.item_progress SET budget_at = now() - interval '30 seconds' WHERE item_id = $1",
      [c.videoItem.id],
    );
    expect(
      ok(await beat(c.learner, c, c.videoItem, { ranges: [[45, 100]], seq: 2, rate: 2 }))
        .watchedSeconds,
    ).toBe(100);
    expect((await row(c.videoItem)).suspicious).toBe(1); // not flagged again
  });

  it('clamps ranges to the duration of the video', async () => {
    const c = await course();
    await owner.query('UPDATE lms.item_progress SET budget_s = 600 WHERE item_id = $1', [
      c.videoItem.id,
    ]);
    ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 5]], seq: 1 }));
    await refill(c, c.videoItem, 600);
    const r = ok(await beat(c.learner, c, c.videoItem, { ranges: [[90, 5000]], seq: 2 }));
    expect(r.watchedSeconds).toBe(15); // 0..5 and 90..100
    expect(r.positionSeconds).toBeLessThanOrEqual(100);
    expect((await row(c.videoItem)).ranges).toBe('{[0,5),[90,100)}');
  });

  it('ignores duplicate and out-of-order heartbeats of the same player, and takes a new player as the newest writer', async () => {
    const c = await course();
    ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 10]], seq: 1 }));
    ok(await beat(c.learner, c, c.videoItem, { ranges: [[10, 20]], seq: 2, position: 20 }));
    // the same number again, and an older one: nothing changes
    const dup = ok(
      await beat(c.learner, c, c.videoItem, { ranges: [[30, 40]], seq: 2, position: 40 }),
    );
    expect(dup).toMatchObject({ result: 'duplicate', watchedSeconds: 20, positionSeconds: 20 });
    expect(ok(await beat(c.learner, c, c.videoItem, { ranges: [[50, 60]], seq: 1 })).result).toBe(
      'duplicate',
    );
    expect((await row(c.videoItem)).watched_seconds).toBe(20);
    // another tab: its own numbering, and its position is the newest
    const other = ok(
      await beat(c.learner, c, c.videoItem, {
        ranges: [[20, 25]],
        seq: 1,
        stream: STREAM_B,
        position: 25,
      }),
    );
    expect(other).toMatchObject({ result: 'ok', watchedSeconds: 25, positionSeconds: 25 });
  });

  it('two tabs at once cannot inflate the time: they share one bucket, and the same seconds count once', async () => {
    const c = await course();
    // tab A uses the whole bucket (45 s)...
    expect(
      ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 45]], seq: 1 })).watchedSeconds,
    ).toBe(45);
    // ...so tab B, claiming 45 other seconds a moment later, gets (almost) nothing
    const b = ok(
      await beat(c.learner, c, c.videoItem, { ranges: [[50, 95]], seq: 1, stream: STREAM_B }),
    );
    expect(b.watchedSeconds).toBeLessThanOrEqual(45 + 2);
    expect((await row(c.videoItem)).suspicious).toBeGreaterThanOrEqual(1);
    // the same part in two tabs counts once
    const c2 = await course();
    ok(await beat(c2.learner, c2, c2.videoItem, { ranges: [[0, 30]], seq: 1 }));
    expect(
      ok(await beat(c2.learner, c2, c2.videoItem, { ranges: [[0, 30]], seq: 1, stream: STREAM_B }))
        .watchedSeconds,
    ).toBe(30);
  });

  it('queued heartbeats that arrive late (after an offline period) are not cut: the bucket holds 10 minutes of room', async () => {
    const c = await course();
    ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 30]], seq: 1 }));
    await owner.query(
      "UPDATE lms.item_progress SET budget_s = 0, budget_at = now() - interval '5 minutes' WHERE item_id = $1",
      [c.videoItem.id],
    );
    // 5 minutes passed: the learner may claim up to 600 s at 2x, here 60 s in two heartbeats sent back to back
    ok(await beat(c.learner, c, c.videoItem, { ranges: [[30, 60]], seq: 2 }));
    expect(
      ok(await beat(c.learner, c, c.videoItem, { ranges: [[60, 90]], seq: 3 })).watchedSeconds,
    ).toBe(90);
    expect((await row(c.videoItem)).suspicious).toBe(0);
  });

  it('a pathologically fragmented claim is refused (and counted), the history is kept', async () => {
    const c = await course();
    ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 5]], seq: 1 }));
    // 16 ranges per heartbeat at most: the limit is in the schema
    const tooMany = await beat(c.learner, c, c.videoItem, {
      ranges: Array.from({ length: 17 }, (_, i) => [i * 2, i * 2 + 1] as [number, number]),
      seq: 2,
    });
    expect(tooMany.statusCode).toBe(400);
    expect((await row(c.videoItem)).watched_seconds).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('completion', () => {
  it('a video completes when the unique coverage reaches the offering’s threshold (default 90 %)', async () => {
    const c = await course();
    await refill(c, c.videoItem, 1).catch(() => undefined);
    ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 45]], seq: 1 }));
    await refill(c, c.videoItem, 600);
    const near = ok(await beat(c.learner, c, c.videoItem, { ranges: [[45, 89]], seq: 2 }));
    expect(near).toMatchObject({ watchedSeconds: 89, completed: false });
    expect(statusOf(await mine(c), c.videoItem)).toBe('in_progress');
    await refill(c, c.videoItem, 600);
    const done = ok(await beat(c.learner, c, c.videoItem, { ranges: [[89, 90]], seq: 3 }));
    expect(done).toMatchObject({ watchedSeconds: 90, completed: true });
    expect(statusOf(await mine(c), c.videoItem)).toBe('completed');
    expect((await row(c.videoItem)).completed_how).toBe('threshold');
  });

  it('the threshold is a setting of the offering (50-100), edited through the offering PATCH by an instructor', async () => {
    const c = await course();
    ok(
      await c.instructor.client.patch(`/offerings/${c.offeringId}`, {
        completionThreshold: 50,
        behindAfterDays: 3,
      }),
    );
    expect(ok(await admin.get(`/offerings/${c.offeringId}`))).toMatchObject({
      completionThreshold: 50,
      behindAfterDays: 3,
    });
    expect(
      (await c.instructor.client.patch(`/offerings/${c.offeringId}`, { completionThreshold: 49 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await c.instructor.client.patch(`/offerings/${c.offeringId}`, { behindAfterDays: 61 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await c.learner.client.patch(`/offerings/${c.offeringId}`, { completionThreshold: 60 }))
        .statusCode,
    ).toBe(403);
    // the label is still the administrators' (offering.manage)
    expect(
      (await c.instructor.client.patch(`/offerings/${c.offeringId}`, { label: 'x' })).statusCode,
    ).toBe(403);
    ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 45]], seq: 1 }));
    await refill(c, c.videoItem, 600);
    expect(
      ok(await beat(c.learner, c, c.videoItem, { ranges: [[45, 50]], seq: 2 })).completed,
    ).toBe(true);
  });

  it('completion is sticky; replacing the video recomputes coverage against the new duration at the next heartbeat', async () => {
    const c = await course();
    await owner.query('UPDATE lms.course_offerings SET completion_threshold = 50 WHERE id = $1', [
      c.offeringId,
    ]);
    const l2 = await person(owner, t, A, 'Second');
    const l3 = await person(owner, t, A, 'Third');
    for (const p of [l2, l3])
      ok(
        await admin.post(`/offerings/${c.offeringId}/participants`, {
          userId: p.userId,
          participation: 'learner',
        }),
      );
    ok(await beat(l2, c, c.videoItem, { ranges: [[0, 45]], seq: 1 })); // 45 of 100: not enough for 50 %
    ok(await beat(l3, c, c.videoItem, { ranges: [[0, 45]], seq: 1 }));
    await owner.query('UPDATE lms.item_progress SET budget_s = 600 WHERE item_id = $1', [
      c.videoItem.id,
    ]);
    expect(ok(await beat(l3, c, c.videoItem, { ranges: [[45, 55]], seq: 2 })).completed).toBe(true); // 55 of 100
    expect(statusOf(await mine(c, l2), c.videoItem)).toBe('in_progress');
    // the instructor replaces the video by one of 60 seconds
    const shorter = await readyVideo(c.offeringId, c.instructor.userId, 60);
    ok(
      await c.instructor.client.patch(`/offerings/${c.offeringId}/items/${c.videoItem.id}`, {
        videoId: shorter,
      }),
    );
    // an old player is told the video changed
    const stale = await beat(l2, c, c.videoItem, { ranges: [[45, 50]], seq: 2 });
    expect(stale.statusCode).toBe(409);
    expect(errorCode(stale)).toBe('video_changed');
    // the rows are kept; the coverage now counts against 60 s: 45 of 60 = 75 % >= 50 %, noticed at the next heartbeat
    expect(statusOf(await mine(c, l2), c.videoItem)).toBe('in_progress');
    const now = ok(await beat(l2, c, c.videoItem, { ranges: [], seq: 2, videoId: shorter }));
    expect(now).toMatchObject({
      durationSeconds: 60,
      watchedSeconds: 45,
      percent: 75,
      completed: true,
    });
    // a completed learner stays completed, even when the new video is longer and their coverage no longer reaches the share
    const longer = await readyVideo(c.offeringId, c.instructor.userId, 400);
    ok(
      await c.instructor.client.patch(`/offerings/${c.offeringId}/items/${c.videoItem.id}`, {
        videoId: longer,
      }),
    );
    expect(statusOf(await mine(c, l3), c.videoItem)).toBe('completed');
    expect(
      ok(await beat(l3, c, c.videoItem, { ranges: [], seq: 3, videoId: longer })),
    ).toMatchObject({ durationSeconds: 400, completed: true });
  });

  it('manual items are marked done and undone by the learner; an on-view item completes when it is opened', async () => {
    const c = await course();
    const text = `/offerings/${c.offeringId}/items/${c.textItem.id}/progress`;
    const link = `/offerings/${c.offeringId}/items/${c.linkItem.id}/progress`;
    expect(ok(await c.learner.client.post(`${text}/viewed`)).status).toBe('in_progress'); // opened, not done
    expect(ok(await c.learner.client.post(`${text}/complete`)).status).toBe('completed');
    expect((await row(c.textItem)).completed_how).toBe('manual');
    expect(ok(await c.learner.client.delete(`${text}/complete`)).status).toBe('in_progress');
    expect(statusOf(await mine(c), c.textItem)).toBe('in_progress');
    // the rule belongs to the item: a link is not marked by hand, a text is not completed by opening it
    const bad = await c.learner.client.post(`${link}/complete`);
    expect(bad.statusCode).toBe(409);
    expect(errorCode(bad)).toBe('wrong_completion_rule');
    expect(ok(await c.learner.client.post(`${link}/viewed`)).status).toBe('completed');
    expect((await row(c.linkItem)).completed_how).toBe('view');
    // an instructor can change the rule of an item
    ok(
      await c.instructor.client.patch(`/offerings/${c.offeringId}/items/${c.textItem.id}`, {
        completion: 'on_view',
      }),
    );
    expect(ok(await c.learner.client.post(`${text}/viewed`)).status).toBe('completed');
    // ...but a video is always "watch", and a text cannot be "watch"
    expect(
      (
        await c.instructor.client.patch(`/offerings/${c.offeringId}/items/${c.textItem.id}`, {
          completion: 'watch',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await c.instructor.client.patch(`/offerings/${c.offeringId}/items/${c.videoItem.id}`, {
          completion: 'manual',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('defaults per type: text is marked by hand, file and link on view, video by watching', async () => {
    const c = await course();
    const outline = ok(await c.instructor.client.get(`/offerings/${c.offeringId}/outline`));
    const by = Object.fromEntries(
      outline.modules[0].items.map((i: Json) => [i.title, [i.completion, i.required]]),
    );
    expect(by).toMatchObject({
      Lecture: ['watch', true],
      Notes: ['manual', true],
      Reading: ['on_view', true],
      Extra: ['manual', false],
    });
  });

  it('a video item with another rule, or a text with "watch", is refused when created', async () => {
    const c = await course();
    const url = `/offerings/${c.offeringId}/modules/${c.moduleId}/items`;
    expect(
      (
        await c.instructor.client.post(url, {
          kind: 'text',
          title: 'x',
          body: doc('a'),
          completion: 'watch',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await c.instructor.client.post(url, {
          kind: 'video',
          title: 'v',
          videoId: c.videoId,
          completion: 'manual',
        })
      ).statusCode,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('percentages: required items that are visible', () => {
  it('module and course progress = completed required / visible required; optional items do not count', async () => {
    const c = await course();
    let m = await mine(c);
    expect(m).toMatchObject({
      participant: true,
      totalRequired: 3,
      completedRequired: 0,
      percent: 0,
    });
    ok(
      await c.learner.client.post(
        `/offerings/${c.offeringId}/items/${c.linkItem.id}/progress/viewed`,
      ),
    );
    ok(
      await c.learner.client.post(
        `/offerings/${c.offeringId}/items/${c.optionalItem.id}/progress/complete`,
      ),
    );
    m = await mine(c);
    expect(m).toMatchObject({ completedRequired: 1, totalRequired: 3, percent: 33 });
    expect(m.modules[0]).toMatchObject({
      moduleId: c.moduleId,
      completedRequired: 1,
      totalRequired: 3,
      percent: 33,
    });
    expect(statusOf(m, c.optionalItem)).toBe('completed');
    expect(m.items.find((i: Json) => i.itemId === c.optionalItem.id).required).toBe(false);
  });

  it('percentages follow new items, unpublished items and archived items; their progress rows stay', async () => {
    const c = await course();
    const base = `/offerings/${c.offeringId}`;
    for (const item of [c.textItem, c.linkItem]) {
      ok(
        await c.learner.client.post(
          `${base}/items/${item.id}/progress/${item === c.textItem ? 'complete' : 'viewed'}`,
        ),
      );
    }
    expect((await mine(c)).percent).toBe(67); // 2 of 3
    // an item added later lowers it
    const later = ok(
      await c.instructor.client.post(`${base}/modules/${c.moduleId}/items`, {
        kind: 'text',
        title: 'Later',
        body: doc('x'),
        published: true,
      }),
    );
    expect((await mine(c)).percent).toBe(50); // 2 of 4
    // an unpublished item stops counting, its progress is kept
    ok(await c.instructor.client.patch(`${base}/items/${c.textItem.id}`, { published: false }));
    expect(await mine(c)).toMatchObject({ completedRequired: 1, totalRequired: 3, percent: 33 });
    expect((await row(c.textItem)).status).toBe('completed');
    ok(await c.instructor.client.patch(`${base}/items/${c.textItem.id}`, { published: true }));
    expect((await mine(c)).percent).toBe(50);
    // required -> optional: stops counting
    ok(await c.instructor.client.patch(`${base}/items/${later.id}`, { required: false }));
    expect((await mine(c)).percent).toBe(67);
    // a locked item is not visible, so it does not count either
    ok(
      await c.instructor.client.patch(`${base}/items/${later.id}`, {
        required: true,
        availableFrom: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    );
    expect((await mine(c)).totalRequired).toBe(3);
  });

  it('a module without a required item has no percentage (null), not 0 or 100', async () => {
    const c = await course();
    const m2 = ok(
      await c.instructor.client.post(`/offerings/${c.offeringId}/modules`, { title: 'Empty' }),
    );
    ok(
      await c.instructor.client.patch(`/offerings/${c.offeringId}/modules/${m2.id}`, {
        published: true,
      }),
    );
    const m = await mine(c);
    expect(m.modules.find((x: Json) => x.moduleId === m2.id)).toMatchObject({
      percent: null,
      totalRequired: 0,
    });
  });

  it('"My courses": the percentage of each course, and where to continue', async () => {
    const c = await course();
    ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 30]], seq: 1, position: 30 }));
    const me = ok(await c.learner.client.get('/me/progress'));
    expect(me.offerings.find((o: Json) => o.offeringId === c.offeringId)).toMatchObject({
      completedRequired: 0,
      totalRequired: 3,
      percent: 0,
    });
    expect(me.resume).toMatchObject({
      offeringId: c.offeringId,
      itemId: c.videoItem.id,
      itemTitle: 'Lecture',
      positionSeconds: 30,
    });
    // the same on the course page
    expect((await mine(c)).resume).toMatchObject({ itemId: c.videoItem.id, positionSeconds: 30 });
    // and the playback session of the video carries the saved position (any device resumes there)
    const play = ok(
      await c.learner.client.post(`/offerings/${c.offeringId}/items/${c.videoItem.id}/playback`),
    );
    expect(play.resumeSeconds).toBe(30);
    // somebody who never watched has none
    const other = await person(owner, t, A, 'Fresh');
    ok(
      await admin.post(`/offerings/${c.offeringId}/participants`, {
        userId: other.userId,
        participation: 'learner',
      }),
    );
    expect(
      ok(await other.client.post(`/offerings/${c.offeringId}/items/${c.videoItem.id}/playback`))
        .resumeSeconds,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
describe('who may record progress', () => {
  it('non-participants get 404, instructors and assistants get 403 (a preview never creates learner progress)', async () => {
    const c = await course();
    const outsider = await person(owner, t, A, 'Outsider');
    const url = `/offerings/${c.offeringId}/items/${c.videoItem.id}/progress`;
    const body = {
      videoId: c.videoId,
      streamId: STREAM_A,
      seq: 1,
      ranges: [[0, 10]],
      position: 10,
      rate: 1,
    };
    const o = await outsider.client.post(`${url}/heartbeat`, body);
    expect(o.statusCode).toBe(404);
    expect(errorCode(o)).toBe('offering_not_found');
    expect((await adminB.post(`${url}/heartbeat`, body)).statusCode).toBe(404); // another college
    for (const p of [c.instructor, c.assistant]) {
      expect((await p.client.post(`${url}/heartbeat`, body)).statusCode).toBe(403);
      expect((await p.client.post(`${url}/viewed`)).statusCode).toBe(403);
    }
    expect(
      (await owner.query('SELECT 1 FROM lms.item_progress WHERE offering_id = $1', [c.offeringId]))
        .rowCount,
    ).toBe(0);
  });

  it('hidden, unpublished, locked, archived items and unpublished offerings: the learner gets 404, nothing is written', async () => {
    const c = await course();
    const base = `/offerings/${c.offeringId}`;
    const hit = async (item: Json) =>
      (await beat(c.learner, c, item, { ranges: [[0, 5]], seq: 1 })).statusCode;
    const link = (item: Json) => c.learner.client.post(`${base}/items/${item.id}/progress/viewed`);
    const make = async (extra: Json) =>
      ok(
        await c.instructor.client.post(`${base}/modules/${c.moduleId}/items`, {
          kind: 'video',
          title: 'v',
          videoId: c.videoId,
          published: true,
          ...extra,
        }),
      );

    const hidden = await make({ published: false });
    const locked = await make({ availableFrom: new Date(Date.now() + 86_400_000).toISOString() });
    expect(await hit(hidden)).toBe(404);
    expect(await hit(locked)).toBe(404);
    expect((await link(hidden)).statusCode).toBe(404);
    expect(errorCode(await link(locked))).toBe('item_not_found');

    const m2 = ok(await c.instructor.client.post(`${base}/modules`, { title: 'Draft module' }));
    const inDraft = ok(
      await c.instructor.client.post(`${base}/modules/${m2.id}/items`, {
        kind: 'link',
        title: 'x',
        url: 'https://example.org',
        published: true,
      }),
    );
    expect((await link(inDraft)).statusCode).toBe(404);

    ok(await c.instructor.client.post(`${base}/unpublish`));
    const down = await c.learner.client.post(`${base}/items/${c.linkItem.id}/progress/viewed`);
    expect(down.statusCode).toBe(404);
    expect(errorCode(down)).toBe('offering_not_found');
    ok(await c.instructor.client.post(`${base}/publish`));

    // a text item is not a video
    const notVideo = await c.learner.client.post(
      `${base}/items/${c.textItem.id}/progress/heartbeat`,
      {
        videoId: c.videoId,
        streamId: STREAM_A,
        seq: 1,
        ranges: [],
        position: 0,
        rate: 1,
      },
    );
    expect(notVideo.statusCode).toBe(409);
    expect(errorCode(notVideo)).toBe('not_a_video_item');
    const rows = await owner.query('SELECT item_id FROM lms.item_progress WHERE offering_id = $1', [
      c.offeringId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('a removed learner can no longer record anything, but their history stays and is shown on request', async () => {
    const c = await course();
    ok(
      await c.learner.client.post(
        `/offerings/${c.offeringId}/items/${c.linkItem.id}/progress/viewed`,
      ),
    );
    const people = ok(await admin.get(`/offerings/${c.offeringId}/participants`));
    const part = people.items.find((x: Json) => x.userId === c.learner.userId);
    ok(await admin.delete(`/offerings/${c.offeringId}/participants/${part.id}`));
    const after = await c.learner.client.post(
      `/offerings/${c.offeringId}/items/${c.linkItem.id}/progress/viewed`,
    );
    expect(after.statusCode).toBe(404);
    expect((await row(c.linkItem)).status).toBe('completed'); // the history is kept
    const active = ok(await c.instructor.client.get(`/offerings/${c.offeringId}/progress/class`));
    expect(active.items.map((r: Json) => r.userId)).not.toContain(c.learner.userId);
    const removed = ok(
      await c.instructor.client.get(`/offerings/${c.offeringId}/progress/class`, {
        query: 'learners=removed',
      }),
    );
    expect(removed.items).toHaveLength(1);
    expect(removed.items[0]).toMatchObject({
      userId: c.learner.userId,
      removed: true,
      completedRequired: 1,
    });
    // and the participation cannot be deleted from under the history
    await expect(
      owner.query('DELETE FROM lms.course_participants WHERE id = $1', [part.id]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('the visibility function agrees with the outline for every combination (parity)', async () => {
    const c = await course();
    const base = `/offerings/${c.offeringId}`;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const states: Json[] = [];
    for (const itemPublished of [true, false]) {
      for (const itemFrom of [null, past, future]) {
        for (const modPublished of [true, false]) {
          for (const modFrom of [null, future]) {
            const m = ok(
              await c.instructor.client.post(`${base}/modules`, { title: `m-${states.length}` }),
            );
            ok(
              await c.instructor.client.patch(`${base}/modules/${m.id}`, {
                published: modPublished,
                availableFrom: modFrom,
              }),
            );
            const it = ok(
              await c.instructor.client.post(`${base}/modules/${m.id}/items`, {
                kind: 'link',
                title: `i-${states.length}`,
                url: 'https://example.org',
                published: itemPublished,
                availableFrom: itemFrom,
              }),
            );
            states.push({
              it,
              expectOpen: itemPublished && modPublished && itemFrom !== future && modFrom === null,
            });
          }
        }
      }
    }
    const outline = ok(await c.learner.client.get(`${base}/outline`));
    const seen = new Map<string, Json>();
    for (const m of outline.modules) for (const i of m.items) seen.set(i.id, i);
    for (const s of states) {
      const fromOutline = seen.has(s.it.id) && seen.get(s.it.id)?.locked === false;
      const { rows } = await owner.query('SELECT 1 FROM lms.learner_item_access($1, $2, $3, $4)', [
        A.tenantId,
        c.learner.userId,
        c.offeringId,
        s.it.id,
      ]);
      expect(rows.length === 1, JSON.stringify(s)).toBe(fromOutline);
      expect(fromOutline, JSON.stringify(s)).toBe(s.expectOpen);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('items with progress are archived, not deleted', () => {
  it('an item without progress is deleted; one with progress is archived and disappears from every view', async () => {
    const c = await course();
    const base = `/offerings/${c.offeringId}`;
    ok(await c.learner.client.post(`${base}/items/${c.linkItem.id}/progress/viewed`));
    // no progress: gone for good
    expect(ok(await c.instructor.client.delete(`${base}/items/${c.optionalItem.id}`)).status).toBe(
      'deleted',
    );
    expect(
      (await owner.query('SELECT 1 FROM lms.content_items WHERE id = $1', [c.optionalItem.id]))
        .rowCount,
    ).toBe(0);
    // progress: archived
    expect(ok(await c.instructor.client.delete(`${base}/items/${c.linkItem.id}`)).status).toBe(
      'archived',
    );
    const kept = await owner.query('SELECT deleted_at FROM lms.content_items WHERE id = $1', [
      c.linkItem.id,
    ]);
    expect(kept.rowCount).toBe(1);
    expect(kept.rows[0].deleted_at).not.toBeNull();
    expect((await row(c.linkItem)).status).toBe('completed'); // the history is intact
    // gone from outlines (editors' and learners'), the item page, percentages and the class view
    for (const p of [c.instructor, c.learner]) {
      const titles = ok(await p.client.get(`${base}/outline`)).modules.flatMap((m: Json) =>
        m.items.map((i: Json) => i.title),
      );
      expect(titles).not.toContain('Reading');
    }
    expect((await c.learner.client.get(`${base}/items/${c.linkItem.id}`)).statusCode).toBe(404);
    expect((await c.instructor.client.delete(`${base}/items/${c.linkItem.id}`)).statusCode).toBe(
      404,
    ); // already archived
    expect(
      (await c.instructor.client.patch(`${base}/items/${c.linkItem.id}`, { title: 'x' }))
        .statusCode,
    ).toBe(404);
    expect((await mine(c)).totalRequired).toBe(2);
    expect(
      (await c.learner.client.post(`${base}/items/${c.linkItem.id}/progress/viewed`)).statusCode,
    ).toBe(404);
    // a copy of the offering does not carry archived items
    const target = ok(
      await admin.post('/offerings', { courseId: (await newCourse(admin)).id, termId: st.termId }),
    );
    ok(
      await admin.post(`/offerings/${target.id}/participants`, {
        userId: c.instructor.userId,
        participation: 'instructor',
      }),
    );
    ok(
      await c.instructor.client.post(`/offerings/${target.id}/copy`, {
        sourceOfferingId: c.offeringId,
      }),
    );
    const copied = ok(
      await c.instructor.client.get(`/offerings/${target.id}/outline`),
    ).modules.flatMap((m: Json) => m.items.map((i: Json) => i.title));
    expect(copied.sort()).toEqual(['Lecture', 'Notes']);
  });

  it('hasProgress is shown to editors only: never to learners (outline, item page), also when they have progress', async () => {
    const c = await course();
    const base = `/offerings/${c.offeringId}`;
    ok(await c.learner.client.post(`${base}/items/${c.linkItem.id}/progress/viewed`));
    const flags = (o: Json) =>
      o.modules.flatMap((m: Json) => [m, ...m.items]).map((x: Json) => x.hasProgress);
    // editors see which items and modules have history
    const editor = ok(await c.instructor.client.get(`${base}/outline`));
    const byTitle = (o: Json, title: string) =>
      o.modules.flatMap((m: Json) => m.items).find((i: Json) => i.title === title);
    expect(byTitle(editor, 'Reading').hasProgress).toBe(true);
    expect(byTitle(editor, 'Lecture').hasProgress).toBe(false);
    expect(editor.modules.some((m: Json) => m.hasProgress === true)).toBe(true);
    // learners get false everywhere, even on the item they have progress on
    const learner = ok(await c.learner.client.get(`${base}/outline`));
    expect(flags(learner).every((f: unknown) => f === false)).toBe(true);
    expect(byTitle(learner, 'Reading').hasProgress).toBe(false);
    // the item page does not carry the flag at all (its response schema has no such field)
    for (const p of [c.learner, c.instructor]) {
      const page = ok(await p.client.get(`${base}/items/${c.linkItem.id}`));
      expect(page).not.toHaveProperty('hasProgress');
    }
  });

  it('the database refuses to delete an item that has progress, and a module is archived with its items', async () => {
    const c = await course();
    const base = `/offerings/${c.offeringId}`;
    ok(await c.learner.client.post(`${base}/items/${c.textItem.id}/progress/complete`));
    await expect(
      owner.query('DELETE FROM lms.content_items WHERE id = $1', [c.textItem.id]),
    ).rejects.toMatchObject({ code: '23503' });
    // a module that has progress anywhere in it is archived whole
    expect(ok(await c.instructor.client.delete(`${base}/modules/${c.moduleId}`)).status).toBe(
      'archived',
    );
    const items = await owner.query(
      'SELECT count(*)::int AS n, count(deleted_at)::int AS gone FROM lms.content_items WHERE module_id = $1',
      [c.moduleId],
    );
    expect(items.rows[0]).toEqual({ n: 4, gone: 4 });
    expect(ok(await c.instructor.client.get(`${base}/outline`)).modules).toEqual([]);
    expect((await row(c.textItem)).status).toBe('completed');
    // a module without progress is deleted
    const empty = ok(await c.instructor.client.post(`${base}/modules`, { title: 'Spare' }));
    expect(ok(await c.instructor.client.delete(`${base}/modules/${empty.id}`)).status).toBe(
      'deleted',
    );
    expect(
      (await owner.query('SELECT 1 FROM lms.content_modules WHERE id = $1', [empty.id])).rowCount,
    ).toBe(0);
  });

  it('an archived video item keeps its video: the video cannot be deleted while history points at it', async () => {
    const c = await course();
    ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 10]], seq: 1 }));
    expect(
      ok(await c.instructor.client.delete(`/offerings/${c.offeringId}/items/${c.videoItem.id}`))
        .status,
    ).toBe('archived');
    const del = await c.instructor.client.delete(`/offerings/${c.offeringId}/videos/${c.videoId}`);
    expect(del.statusCode).toBe(409);
    expect(errorCode(del)).toBe('video_in_use');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the class views', () => {
  async function classroom() {
    const c = await course();
    const names = ['Asha', 'Bela', 'Chitra'];
    const learners: Person[] = [];
    for (const [i, n] of names.entries()) {
      const p = await student(owner, t, A, admin, st, i === 2 ? st.sectionB : st.sectionA, n);
      await owner.query('UPDATE lms.users SET display_name = $2 WHERE id = $1', [p.userId, n]);
      ok(
        await admin.post(`/offerings/${c.offeringId}/participants`, {
          userId: p.userId,
          participation: 'learner',
        }),
      );
      learners.push(p);
    }
    return { c, learners };
  }
  const view = (p: Person, c: Course, query = '') =>
    p.client.get(`/offerings/${c.offeringId}/progress/class`, query ? { query } : {});

  it('lists learners with module and overall percentages and a status; the learner who did most sorts first by percent', async () => {
    const { c, learners } = await classroom();
    const [asha, bela] = learners as [Person, Person, Person];
    const base = `/offerings/${c.offeringId}/items`;
    ok(await asha.client.post(`${base}/${c.linkItem.id}/progress/viewed`));
    ok(await asha.client.post(`${base}/${c.textItem.id}/progress/complete`));
    ok(await bela.client.post(`${base}/${c.textItem.id}/progress/viewed`)); // opened only
    const page = ok(await view(c.instructor, c, 'sort=percent&dir=desc'));
    expect(page.total).toBe(4); // three students + the learner of course()
    expect(page.modules).toEqual([{ id: c.moduleId, title: 'Week 1' }]);
    const byName = Object.fromEntries(page.items.map((r: Json) => [r.displayName, r]));
    expect(byName.Asha).toMatchObject({
      completedRequired: 2,
      totalRequired: 3,
      percent: 67,
      status: 'in_progress',
      sectionName: 'A',
    });
    expect(byName.Asha.modules).toEqual([{ moduleId: c.moduleId, percent: 67 }]);
    expect(byName.Bela).toMatchObject({ completedRequired: 0, percent: 0, status: 'in_progress' });
    expect(byName.Chitra).toMatchObject({
      status: 'not_started',
      percent: 0,
      sectionName: 'B',
      lastActivityAt: null,
    });
    expect(page.items[0].displayName).toBe('Asha');
  });

  it('statuses: completed, behind (a required item open longer than the offering’s days), not started', async () => {
    const { c, learners } = await classroom();
    const [asha, bela] = learners as [Person, Person, Person];
    const base = `/offerings/${c.offeringId}/items`;
    await owner.query('UPDATE lms.course_offerings SET completion_threshold = 50 WHERE id = $1', [
      c.offeringId,
    ]);
    ok(await asha.client.post(`${base}/${c.linkItem.id}/progress/viewed`));
    ok(await asha.client.post(`${base}/${c.textItem.id}/progress/complete`));
    ok(await beat(asha, c, c.videoItem, { ranges: [[0, 45]], seq: 1 }));
    await refill(c, c.videoItem, 600);
    ok(await beat(asha, c, c.videoItem, { ranges: [[45, 50]], seq: 2 }));
    ok(await bela.client.post(`${base}/${c.linkItem.id}/progress/viewed`));
    // everything was created just now: nobody is behind yet (7 days)
    expect(ok(await view(c.instructor, c, 'status=behind')).total).toBe(0);
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await owner.query('UPDATE lms.content_items SET created_at = $2 WHERE id = ANY($1)', [
      [c.textItem.id, c.linkItem.id, c.videoItem.id],
      old,
    ]);
    const completed = ok(await view(c.instructor, c, 'status=completed'));
    expect(completed.items.map((r: Json) => r.displayName)).toEqual(['Asha']);
    const behind = ok(await view(c.instructor, c, 'status=behind&sort=name'));
    expect(behind.items.map((r: Json) => r.displayName)).toEqual(['Bela', 'Chitra', 'Learner']);
    expect(behind.items.every((r: Json) => r.status === 'behind')).toBe(true);
    // the days are the offering's setting
    await owner.query('UPDATE lms.course_offerings SET behind_after_days = 30 WHERE id = $1', [
      c.offeringId,
    ]);
    expect(ok(await view(c.instructor, c, 'status=behind')).total).toBe(0);
    const notStarted = ok(await view(c.instructor, c, 'status=not_started'));
    expect(notStarted.items.map((r: Json) => r.displayName)).toContain('Chitra');
    expect(notStarted.items.map((r: Json) => r.displayName)).not.toContain('Bela');
  });

  it('filters by section and pages with a keyset: no duplicates, no gaps, in every sort', async () => {
    const { c } = await classroom();
    const onlyB = ok(await view(c.instructor, c, `section=${st.sectionB}`));
    expect(onlyB.items.map((r: Json) => r.displayName)).toEqual(['Chitra']);
    for (const sort of ['name', 'percent', 'activity']) {
      for (const dir of ['asc', 'desc']) {
        const seen: string[] = [];
        let after = '';
        for (let guard = 0; guard < 10; guard++) {
          const p = ok(await view(c.instructor, c, `limit=2&sort=${sort}&dir=${dir}${after}`));
          seen.push(...p.items.map((r: Json) => r.participantId));
          if (!p.nextCursor) break;
          after = `&after=${encodeURIComponent(p.nextCursor)}`;
        }
        expect(new Set(seen).size, `${sort} ${dir}`).toBe(seen.length);
        expect(seen, `${sort} ${dir}`).toHaveLength(4);
      }
    }
    expect((await view(c.instructor, c, 'after=not-a-cursor')).statusCode).toBe(200); // a bad cursor starts from the top
  });

  it('who may see it: instructors, assistants and administrators (read only); learners never see other learners', async () => {
    const { c, learners } = await classroom();
    for (const p of [c.instructor, c.assistant]) expect((await view(p, c)).statusCode).toBe(200);
    expect((await admin.get(`/offerings/${c.offeringId}/progress/class`)).statusCode).toBe(200); // not a participant, read only
    for (const l of [c.learner, learners[0] as Person]) {
      expect((await view(l, c)).statusCode).toBe(403);
      expect((await l.client.get(`/offerings/${c.offeringId}/progress/class.csv`)).statusCode).toBe(
        403,
      );
      expect(
        (await l.client.get(`/offerings/${c.offeringId}/progress/learners/${newId()}`)).statusCode,
      ).toBe(403);
    }
    const outsider = await person(owner, t, A, 'Outsider');
    expect((await view(outsider, c)).statusCode).toBe(404);
    expect((await adminB.get(`/offerings/${c.offeringId}/progress/class`)).statusCode).toBe(404);
    // an administrator cannot record progress (a read-only role)
    const rec = await admin.post(
      `/offerings/${c.offeringId}/items/${c.linkItem.id}/progress/viewed`,
    );
    expect([403, 404]).toContain(rec.statusCode);
  });

  it('the drilldown shows every item of one learner: status, watched share, last activity, flagged heartbeats', async () => {
    const { c } = await classroom();
    ok(await beat(c.learner, c, c.videoItem, { ranges: [[0, 80]], seq: 1 })); // clamped: flagged
    ok(
      await c.learner.client.post(
        `/offerings/${c.offeringId}/items/${c.linkItem.id}/progress/viewed`,
      ),
    );
    const list = ok(await view(c.instructor, c));
    const me = list.items.find((r: Json) => r.userId === c.learner.userId);
    const d = ok(
      await c.instructor.client.get(
        `/offerings/${c.offeringId}/progress/learners/${me.participantId}`,
      ),
    );
    expect(d.learner).toMatchObject({
      participantId: me.participantId,
      completedRequired: 1,
      totalRequired: 3,
      percent: 33,
    });
    const by = Object.fromEntries(d.items.map((i: Json) => [i.title, i]));
    expect(by.Lecture).toMatchObject({
      status: 'in_progress',
      watchedSeconds: 45,
      durationSeconds: 100,
      watchedPercent: 45,
      flagged: 1,
      kind: 'video',
    });
    expect(by.Reading).toMatchObject({
      status: 'completed',
      completedHow: 'view',
      watchedPercent: null,
    });
    expect(by.Notes.status).toBe('not_started');
    expect(by.Extra.required).toBe(false);
    expect(by.Lecture.moduleTitle).toBe('Week 1');
    const missing = await c.instructor.client.get(
      `/offerings/${c.offeringId}/progress/learners/${newId()}`,
    );
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing)).toBe('learner_not_found');
  });

  it('exports the table as CSV: header, one line per learner, formulas neutralised, a download', async () => {
    const { c, learners } = await classroom();
    await owner.query('UPDATE lms.users SET display_name = $2 WHERE id = $1', [
      (learners[0] as Person).userId,
      '=HYPERLINK("http://evil.test","x")',
    ]);
    ok(
      await (learners[1] as Person).client.post(
        `/offerings/${c.offeringId}/items/${c.linkItem.id}/progress/viewed`,
      ),
    );
    const res = await c.instructor.client.get(`/offerings/${c.offeringId}/progress/class.csv`, {
      query: 'sort=name',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const text = res.body.replace(/^﻿/, '');
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'Learner,Email,Section,Status,Completed required items,Required items,Progress %,Last activity,Week 1 %',
    );
    expect(lines).toHaveLength(5);
    expect(text).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")"`); // output rule: a leading apostrophe, then CSV quoting
    expect(text).not.toMatch(/(^|\r\n)=/);
    expect(lines.find((l) => l.startsWith('Bela'))).toContain(',in_progress,1,3,33,');
    // learners cannot download it, and a refusal is a normal JSON error (nothing was streamed)
    const denied = await c.learner.client.get(`/offerings/${c.offeringId}/progress/class.csv`);
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['content-type']).toContain('application/json');
  });

  it('a large class is exported page by page', async () => {
    const c = await course();
    for (let i = 0; i < 7; i++) {
      const p = await person(owner, t, A, `Bulk${i}`);
      ok(
        await admin.post(`/offerings/${c.offeringId}/participants`, {
          userId: p.userId,
          participation: 'learner',
        }),
      );
    }
    const small = createProgressService({
      db: t.db,
      progressRepo: createProgressRepository(),
      config: { csvPage: 3 },
    });
    const ctx = {
      userId: c.instructor.userId,
      tenantId: A.tenantId,
      role: 'member',
      isPlatformAdmin: false,
      sessionId: 's',
      email: c.instructor.email,
      displayName: 'x',
      ip: null,
      userAgent: null,
    } as never;
    const lines: string[] = [];
    for await (const chunk of small.classCsv(ctx, c.offeringId, {
      section: null,
      status: null,
      removed: false,
      sort: 'name',
      dir: 'asc',
    }))
      lines.push(chunk);
    expect(lines.length).toBe(1 + 8); // the header, 7 learners and the course's own learner, three per query
    expect(new Set(lines).size).toBe(lines.length);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the page-hide request passes CSRF (fetch with keepalive, not sendBeacon)', () => {
  it('needs Origin and X-Requested-With like every mutation; a request without them (what sendBeacon would send) is refused', async () => {
    const c = await course();
    const url = `/offerings/${c.offeringId}/items/${c.videoItem.id}/progress/heartbeat`;
    const body = JSON.stringify({
      videoId: c.videoId,
      streamId: STREAM_A,
      seq: 1,
      ranges: [[0, 10]],
      position: 10,
      rate: 1,
    });
    const cookie = [...c.learner.client.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const send = (headers: Record<string, string>) =>
      t.app.inject({
        method: 'POST',
        url: `/api${url}`,
        payload: body,
        headers: { host: A.host, cookie, 'content-type': 'application/json', ...headers },
      });
    // exactly the headers the player's keepalive fetch sends
    const ok1 = await send({ origin: `http://${A.host}`, 'x-requested-with': 'lms' });
    expect(ok1.statusCode, ok1.body).toBe(200);
    // a beacon cannot set X-Requested-With
    const beacon = await send({
      origin: `http://${A.host}`,
      'content-type': 'text/plain;charset=UTF-8',
    });
    expect(beacon.statusCode).toBe(403);
    // nor can another site
    expect((await send({ origin: 'http://evil.test', 'x-requested-with': 'lms' })).statusCode).toBe(
      403,
    );
    expect((await row(c.videoItem)).watched_seconds).toBe(10);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('definer functions: hardening', () => {
  it('are SECURITY DEFINER where they write, owner-owned, with a pinned search_path, executable by lms_app only', async () => {
    const { rows } = await owner.query(
      `SELECT p.proname, p.prosecdef, p.proconfig AS config, r.rolname AS owner,
              COALESCE((SELECT array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)
                          FROM aclexplode(p.proacl) a), '{}') AS acl
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.pronamespace = 'lms'::regnamespace
          AND p.proname IN ('progress_heartbeat', 'progress_mark', 'progress_gate', 'learner_item_access')`,
    );
    const me = (await owner.query('SELECT current_user')).rows[0].current_user;
    expect(rows.map((r) => r.proname).sort()).toEqual([
      'learner_item_access',
      'progress_gate',
      'progress_heartbeat',
      'progress_mark',
    ]);
    for (const f of rows) {
      expect(f.owner, f.proname).toBe(me);
      expect(f.config, f.proname).toContain('search_path=lms, pg_temp');
      expect(f.acl, f.proname).toContain('lms_app');
      for (const bad of ['PUBLIC', 'anon', 'authenticated'])
        expect(f.acl, `${f.proname} ${bad}`).not.toContain(bad);
      expect(f.prosecdef, f.proname).toBe(
        f.proname === 'progress_heartbeat' || f.proname === 'progress_mark',
      );
    }
  });

  it('lms_app can read progress but not write it, and a college sees only its own', async () => {
    const { rows } = await owner.query(
      `SELECT has_table_privilege('lms_app', 'lms.item_progress', 'SELECT') AS s, has_table_privilege('lms_app', 'lms.item_progress', 'INSERT') AS i,
              has_table_privilege('lms_app', 'lms.item_progress', 'UPDATE') AS u, has_table_privilege('lms_app', 'lms.item_progress', 'DELETE') AS d`,
    );
    expect(rows[0]).toEqual({ s: true, i: false, u: false, d: false });
    const c = await course();
    ok(
      await c.learner.client.post(
        `/offerings/${c.offeringId}/items/${c.linkItem.id}/progress/viewed`,
      ),
    );
    const other = await t.db.withTenant(B.tenantId, (tx) =>
      tx.execute(sql`SELECT 1 FROM lms.item_progress WHERE item_id = ${c.linkItem.id}::uuid`),
    );
    expect(other.rows).toHaveLength(0);
    const mineRows = await t.db.withTenant(A.tenantId, (tx) =>
      tx.execute(sql`SELECT 1 FROM lms.item_progress WHERE item_id = ${c.linkItem.id}::uuid`),
    );
    expect(mineRows.rows).toHaveLength(1);
  });

  it('the function cannot be tricked into another college: tenant, user and item must belong together', async () => {
    const c = await course();
    const url = `/offerings/${c.offeringId}/items/${c.linkItem.id}/progress/viewed`;
    expect((await adminB.post(url)).statusCode).toBe(404);
    const bLearner = await person(owner, t, B, 'BLearner');
    expect((await bLearner.client.post(url)).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('round-trip budgets', () => {
  it('heartbeat and mark: 2 (the session lookup and ONE call); the reads: 4', async () => {
    const c = await course();
    const count = async (fn: () => Promise<unknown>) => {
      t.statements.reset();
      await fn();
      await t.app.modules.background.drain();
      return t.statements.count;
    };
    await c.learner.client.get('/auth/me'); // warm the pool, the slug cache and the session
    const hb = await count(() => beat(c.learner, c, c.videoItem, { ranges: [[0, 10]], seq: 1 }));
    expect(hb, 'heartbeat').toBeLessThanOrEqual(2);
    const dup = await count(() => beat(c.learner, c, c.videoItem, { ranges: [[0, 10]], seq: 1 }));
    expect(dup, 'duplicate heartbeat').toBeLessThanOrEqual(2);
    const viewed = await count(() =>
      c.learner.client.post(`/offerings/${c.offeringId}/items/${c.linkItem.id}/progress/viewed`),
    );
    expect(viewed, 'viewed').toBeLessThanOrEqual(2);
    const done = await count(() =>
      c.learner.client.post(`/offerings/${c.offeringId}/items/${c.textItem.id}/progress/complete`),
    );
    expect(done, 'complete').toBeLessThanOrEqual(2);
    const undo = await count(() =>
      c.learner.client.delete(
        `/offerings/${c.offeringId}/items/${c.textItem.id}/progress/complete`,
      ),
    );
    expect(undo, 'uncomplete').toBeLessThanOrEqual(2);
    const reads: [string, () => Promise<unknown>][] = [
      [
        'GET /offerings/:id/progress',
        () => c.learner.client.get(`/offerings/${c.offeringId}/progress`),
      ],
      ['GET /me/progress', () => c.learner.client.get('/me/progress')],
      [
        'GET .../progress/class',
        () => c.instructor.client.get(`/offerings/${c.offeringId}/progress/class`),
      ],
      [
        'GET .../progress/learners/:id',
        async () => {
          const p = ok(await c.instructor.client.get(`/offerings/${c.offeringId}/progress/class`));
          t.statements.reset();
          return c.instructor.client.get(
            `/offerings/${c.offeringId}/progress/learners/${p.items[0].participantId}`,
          );
        },
      ],
    ];
    await c.instructor.client.get('/auth/me');
    for (const [name, fn] of reads) {
      const n = await count(fn);
      process.stdout.write(`ROUND-TRIPS ${name}: ${n} (budget 4)\n`);
      expect(n, name).toBeLessThanOrEqual(4);
    }
    process.stdout.write(
      `ROUND-TRIPS heartbeat: ${hb} (budget 2), viewed ${viewed}, complete ${done}\n`,
    );
  });
});
