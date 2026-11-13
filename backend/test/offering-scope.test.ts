import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PARTICIPATION_PERMISSIONS,
  type ParticipationType,
  type Permission,
  type RouteDeclaration,
} from '../src/core/authz';
import { makeApp, type TestApp } from './app';
import type { TestClient } from './client';
import {
  errorCode,
  loginAs,
  newCourse,
  newOffering,
  ok,
  type Person,
  person,
  structure,
} from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Every route declared with `scope: 'offering'` is probed against a REAL offering:
//  - a member who takes no part in it gets 404 (its existence is not revealed), never 403;
//  - a participant whose part lacks the route's permission gets 403, never a silent success.
// A new scope:'offering' route must get a request here, or this test fails (so none can be forgotten).

const U = '00000000-0000-7000-8000-000000000000';

/** Bodies for the routes that need one (valid, so validation never hides the authorization answer). */
const BODIES: Record<string, unknown> = {
  'PATCH /offerings/:id': { label: 'x' },
  'POST /offerings/:id/sections': { sectionId: U },
  'POST /offerings/:id/participants': { userId: U, participation: 'learner' },
  'PATCH /offerings/:id/participants/:participantId': { participation: 'learner' },
  'POST /offerings/:id/modules': { title: 'x' },
  'PATCH /offerings/:id/modules/:moduleId': { title: 'x' },
  'POST /offerings/:id/modules/:moduleId/move': { after: null },
  'POST /offerings/:id/modules/:moduleId/items': { kind: 'link', title: 'x', url: 'https://e.org' },
  'PATCH /offerings/:id/items/:itemId': { title: 'x' },
  'POST /offerings/:id/items/:itemId/move': { after: null },
  'POST /offerings/:id/copy': { sourceOfferingId: U },
  'POST /offerings/:id/files': { name: 'a.pdf', size: 10 },
  'POST /offerings/:id/videos': { fileName: 'a.mp4', size: 10 },
  'PATCH /offerings/:id/videos/:videoId/upload': {},
  'POST /offerings/:id/videos/:videoId/complete': {},
  'POST /offerings/:id/videos/:videoId/captions': {
    language: 'en',
    label: 'English',
    content: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n',
  },
  'POST /offerings/:id/items/:itemId/playback': {},
  'POST /offerings/:id/items/:itemId/progress/heartbeat': {
    videoId: U,
    streamId: U,
    seq: 1,
    ranges: [],
    position: 0,
    rate: 1,
  },
  'POST /offerings/:id/items/:itemId/progress/viewed': {},
  'POST /offerings/:id/items/:itemId/progress/complete': {},
  'PUT /offerings/:id/items/:itemId/assessment': { attemptsAllowed: 1 },
  'PUT /offerings/:id/items/:itemId/assessment/slots': { slots: [] },
  'PUT /offerings/:id/items/:itemId/assessment/accommodations/:participantId': { extraMinutes: 0 },
  'POST /offerings/:id/items/:itemId/attempts': {},
  'PUT /offerings/:id/attempts/:attemptId/answers': { answers: [] },
  'POST /offerings/:id/attempts/:attemptId/submit': {},
  'PUT /offerings/:id/attempts/:attemptId/questions/:position/grade': { score: 0 },
  'PUT /offerings/:id/attempts/:attemptId/feedback': { feedback: null },
  'POST /offerings/:id/items/:itemId/assessment/regrade': {
    questionId: U,
    action: 'drop',
    dryRun: true,
  },
  'POST /offerings/:id/items/:itemId/assessment/release': {},
  'PUT /offerings/:id/items/:itemId/assignment': { maxPoints: 5 },
  'PUT /offerings/:id/items/:itemId/assignment/attachments': { fileIds: [] },
  'PUT /offerings/:id/items/:itemId/assignment/rubric': { rubricId: null },
  'PUT /offerings/:id/items/:itemId/assignment/extensions/:participantId': {
    extendedDueAt: '2030-01-01T00:00:00.000Z',
  },
  'POST /offerings/:id/items/:itemId/assignment/files': { name: 'a.pdf', size: 10 },
  'POST /offerings/:id/items/:itemId/assignment/files/:fileId/confirm': {},
  'POST /offerings/:id/items/:itemId/assignment/submissions': { requestKey: U, fileIds: [] },
  'PUT /offerings/:id/items/:itemId/assignment/grading/learners/:learnerKey/grade': {
    submissionId: U,
    rawScore: 1,
  },
  'PUT /offerings/:id/items/:itemId/assignment/grading/learners/:learnerKey/penalty-waiver': {
    reason: 'because',
  },
  'POST /offerings/:id/items/:itemId/assignment/release': {},
  'PATCH /offerings/:id/gradebook/settings': { outOf: 10 },
  'PUT /offerings/:id/gradebook/categories': {
    categories: [{ name: 'x', weight: 1, dropLowest: 0, missingPolicy: 'exclude' }],
  },
  'PUT /offerings/:id/gradebook/items': { items: [] },
  'PUT /offerings/:id/gradebook/marks': { cells: [{ itemId: U, participantId: U, points: '1' }] },
  'POST /offerings/:id/gradebook/mark-imports': { csv: 'register_number,A\nR1,1' },
  'POST /offerings/:id/gradebook/mark-imports/:importId/apply': {},
  'PUT /offerings/:id/gradebook/learners/:participantId/override': {
    itemId: null,
    points: '1',
    reason: 'because',
  },
  'POST /offerings/:id/gradebook/submit': {},
  'POST /offerings/:id/gradebook/approve': {},
  'POST /offerings/:id/gradebook/return': { comment: 'because' },
  'POST /offerings/:id/gradebook/unlock': { reason: 'because' },
};

/** Routes whose schema needs a query string or a number in the path to get past validation. */
const QUERIES: Record<string, string> = {
  'GET /offerings/:id/items/:itemId/assessment/grading/answers': `questionId=${U}`,
  'GET /offerings/:id/copy-preview': `sourceOfferingId=${U}`,
};

interface Probe {
  key: string;
  method: string;
  url: string;
  permission: Permission;
}

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
const probes: Probe[] = [];
let offeringId: string;
let outsider: Person;
let learner: Person;
let assistant: Person;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp();
  t.app.addHook('onRoute', (route) => {
    const cfg = route.config as RouteDeclaration | undefined;
    if (cfg?.scope !== 'offering' || route.method === 'HEAD') return;
    probes.push({
      key: `${String(route.method)} ${route.url.replace(/^\/api/, '')}`,
      method: String(route.method),
      url: route.url.replace(/^\/api/, ''),
      permission: cfg.permission as Permission,
    });
  });
  A = await createAuthFixture(owner, 'os-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  const s = await structure(admin);
  const c = await newCourse(admin);
  const o = await newOffering(admin, c.id, s.termId);
  offeringId = o.id;
  outsider = await person(owner, t, A, 'Outsider');
  learner = await person(owner, t, A, 'Learner');
  assistant = await person(owner, t, A, 'Assistant');
  const instructor = await person(owner, t, A, 'Instructor');
  for (const [p, kind] of [
    [learner, 'learner'],
    [assistant, 'assistant'],
    [instructor, 'instructor'],
  ] as const) {
    ok(
      await admin.post(`/offerings/${o.id}/participants`, {
        userId: p.userId,
        participation: kind,
      }),
    );
  }
  ok(await instructor.client.post(`/offerings/${o.id}/publish`));
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const fill = (url: string) =>
  url
    .replace(':id', offeringId)
    .replace(':position', '1')
    .replace(/:[A-Za-z]+/g, U);
const send = (c: TestClient, p: Probe) =>
  c.request(p.method, fill(p.url), {
    ...(p.key in BODIES ? { body: BODIES[p.key] } : {}),
    ...(p.key in QUERIES ? { query: QUERIES[p.key] as string } : {}),
  });

describe("routes declared with scope 'offering'", () => {
  it('there are some, and each has a probe request when it needs a body', () => {
    expect(probes.length).toBeGreaterThanOrEqual(25);
    const needBody = probes.filter((p) => ['POST', 'PATCH', 'PUT'].includes(p.method));
    // a POST without a body is only fine for the action routes (publish, archive, ...)
    const actionRoutes = /\/(publish|unpublish|archive)$/;
    const missing = needBody.filter((p) => !(p.key in BODIES) && !actionRoutes.test(p.url));
    expect(missing.map((p) => p.key)).toEqual([]);
  });

  it('a member who takes no part gets 404 (offering_not_found) from every one of them', async () => {
    const wrong: string[] = [];
    for (const p of probes) {
      const res = await send(outsider.client, p);
      if (res.statusCode !== 404 || errorCode(res) !== 'offering_not_found') {
        wrong.push(`${p.key} -> ${res.statusCode} ${res.body.slice(0, 80)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it.each([
    ['learner', 'learner' as ParticipationType],
    ['assistant', 'assistant' as ParticipationType],
  ])('a %s gets 403 from every one whose permission their part lacks', async (who, part) => {
    const client = (who === 'learner' ? learner : assistant).client;
    const wrong: string[] = [];
    let forbidden = 0;
    for (const p of probes) {
      if (PARTICIPATION_PERMISSIONS[part].has(p.permission)) continue; // allowed: covered elsewhere
      const res = await send(client, p);
      forbidden++;
      if (res.statusCode !== 403)
        wrong.push(`${p.key} -> ${res.statusCode} ${res.body.slice(0, 80)}`);
    }
    expect(forbidden).toBeGreaterThan(5);
    expect(wrong).toEqual([]);
  });

  it('an administrator who does not take part is not forbidden from reading, but cannot edit or publish', async () => {
    for (const p of probes) {
      const res = await send(admin, p);
      if (p.permission === 'course.edit' || p.permission === 'course.publish') {
        expect(res.statusCode, p.key).toBe(403);
      }
    }
  });
});
