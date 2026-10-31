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

const fill = (url: string) => url.replace(':id', offeringId).replace(/:[A-Za-z]+/g, U);
const send = (c: TestClient, p: Probe) =>
  c.request(p.method, fill(p.url), p.key in BODIES ? { body: BODIES[p.key] } : {});

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
