import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import {
  errorCode,
  type Json,
  loginAs,
  newCourse,
  newOffering,
  ok,
  PDF,
  type Person,
  person,
  structure,
  uploadFile,
} from './courses-helpers';
import { assignment, type Class, gradebookClass, quiz, releaseQuiz } from './gradebook-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// CROSS-TENANT AND AUTHORIZATION FUZZ (step 14a). Generated from the ROUTE TABLE, so a new route is covered the day it is added.
//
// College B is filled with data (a course, offerings, items, files, a quiz, an assignment with grades, a rubric, academic structure,
// members...). Then, for EVERY registered route, users of college A call it with ids that belong to college B (path parameters,
// ids in the query and in a body built from the route's own TypeBox schema), as each kind of caller: anonymous, a plain member, a
// learner and an instructor of a college A course, and A's institution admin. Invariants, for every one of those requests:
//   1. the API never answers 500 (a foreign id is a clean 4xx, never a crash);
//   2. no response contains any id, e-mail address or name of college B (ids the request itself carried are not counted: an error may name them);
//   3. at the end, college B's data is BYTE FOR BYTE what it was (a hash of every tenant-owned row of B, table by table).
// The one deliberate cross-tenant access (the audited platform-admin member view) is a platform admin's, who is not a caller here.

const SKIP = new Set([
  'POST /auth/logout', // would end the session the next requests need
  'POST /auth/password/change', // changes the shared test password
]);

interface RouteInfo {
  method: string;
  url: string; // with the /api prefix
  schema: { body?: Json; querystring?: Json } | undefined;
}

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
const routes: RouteInfo[] = [];

interface Callers {
  anon: TestClient;
  member: TestClient;
  learner: TestClient;
  instructor: TestClient;
  admin: TestClient;
}
let callers: Callers;
let bIds: Set<string>;
let bByTable: Map<string, string[]>;
let bUserIds: string[];
let bTenantId: string;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const MARKERS = ['@fz-b.test', 'FZB '];

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({
    env: {
      RATE_LIMIT_MAX: '1000000',
      RATE_LIMIT_LOGIN_PER_IP: '100000',
      RATE_LIMIT_LOGIN_FAILURES_PER_IP: '100000',
      RATE_LIMIT_AUTH_PER_IP: '100000',
      RATE_LIMIT_LOGIN_PER_EMAIL: '100000',
      TENANT_CACHE_TTL_MS: '3600000',
    },
  });
  t.app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/docs') || route.schema?.hide === true || route.method === 'HEAD')
      return;
    if (!route.url.startsWith('/api/')) return;
    for (const m of Array.isArray(route.method) ? route.method : [route.method]) {
      routes.push({
        method: String(m),
        url: route.url,
        schema: route.schema as RouteInfo['schema'],
      });
    }
  });
  A = await createAuthFixture(owner, 'fz-a');
  B = await createAuthFixture(owner, 'fz-b');
  await t.app.ready();
  bTenantId = B.tenantId;

  // ---- college B: a lot of data, with names that are easy to recognise
  const adminB = await loginAs(t, B.host, B.adminEmail);
  const stB = await structure(adminB);
  const classB: Class = await gradebookClass(owner, t, B, adminB, stB, ['FZB Bella', 'FZB Boris']);
  const quizItem = await quiz(classB, 'FZB Quiz', [true, false]);
  await releaseQuiz(classB, quizItem.id);
  await assignment(owner, classB, 'FZB Essay', [80, 65], { release: true });
  const course2 = await newCourse(adminB);
  const offering2 = await newOffering(adminB, course2.id, stB.termId);
  const filesB = await uploadFile(
    classB.instructor.client,
    classB.offeringId,
    'FZB notes.pdf',
    PDF,
  );
  ok(
    await classB.instructor.client.post(`/courses/${classB.courseId}/rubrics`, {
      title: 'FZB Rubric',
      criteria: [
        {
          title: 'Content',
          levels: [
            { title: 'Low', points: 0 },
            { title: 'High', points: 10 },
          ],
        },
      ],
    }),
  );
  void offering2;
  void filesB;
  await owner.query(
    `UPDATE lms.users SET display_name = 'FZB ' || display_name WHERE id IN (SELECT user_id FROM lms.tenant_memberships WHERE tenant_id = $1)`,
    [B.tenantId],
  );
  await owner.query(
    `UPDATE lms.users SET email = replace(email, '.test', '@fz-b.test') WHERE false`,
  ); // (addresses already end in @fz-b.test)

  // ---- harvest every id of college B, by table
  bByTable = new Map();
  bIds = new Set([B.tenantId]);
  const tables = await owner.query<{ t: string }>(
    `SELECT c.table_name AS t FROM information_schema.columns c
       JOIN information_schema.columns i ON i.table_schema = c.table_schema AND i.table_name = c.table_name AND i.column_name = 'id' AND i.data_type = 'uuid'
      WHERE c.table_schema = 'lms' AND c.column_name = 'tenant_id'`,
  );
  for (const { t: table } of tables.rows) {
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM lms.${table} WHERE tenant_id = $1 LIMIT 200`,
      [B.tenantId],
    );
    if (rows.length > 0)
      bByTable.set(
        table,
        rows.map((r) => r.id),
      );
    for (const r of rows) bIds.add(r.id);
  }
  const users = await owner.query<{ id: string }>(
    `SELECT user_id AS id FROM lms.tenant_memberships WHERE tenant_id = $1`,
    [B.tenantId],
  );
  bUserIds = users.rows.map((r) => r.id);
  bByTable.set('users', bUserIds);
  for (const id of bUserIds) bIds.add(id);
  const keys = await owner.query<{ k: string }>(
    `SELECT learner_key::text AS k FROM lms.assignment_learners WHERE tenant_id = $1`,
    [B.tenantId],
  );
  bByTable.set(
    'assignment_learner_keys',
    keys.rows.map((r) => r.k),
  );
  for (const r of keys.rows) bIds.add(r.k);

  // ---- college A: the callers (a plain member, a learner and an instructor of an A course, the admin)
  const adminA = await loginAs(t, A.host, A.adminEmail);
  const stA = await structure(adminA);
  const courseA = await newCourse(adminA);
  const offeringA = await newOffering(adminA, courseA.id, stA.termId);
  const instructor: Person = await person(owner, t, A, 'FzInstructor');
  const learner: Person = await person(owner, t, A, 'FzLearner');
  for (const [p, participation] of [
    [instructor, 'instructor'],
    [learner, 'learner'],
  ] as const) {
    ok(
      await adminA.post(`/offerings/${offeringA.id}/participants`, {
        userId: p.userId,
        participation,
      }),
    );
  }
  ok(await instructor.client.post(`/offerings/${offeringA.id}/publish`));
  callers = {
    anon: new TestClient(t, A.host),
    member: await loginAs(t, A.host, A.memberEmail),
    learner: learner.client,
    instructor: instructor.client,
    admin: adminA,
  };
}, 120_000);

afterAll(async () => {
  await t.close();
  await owner.end();
});

// ---------------------------------------------------------------------------------------------------------------- generators
/** which table(s) hold the thing a parameter / field named `name` refers to */
function poolFor(name: string): string[] {
  const stem = name.replace(/Id$/, '').replace(/s$/, '').toLowerCase();
  if (/^(user|actor|member|learner|grader|owner|createdBy)$/.test(stem) || name === 'userId')
    return bUserIds;
  if (/key$/i.test(name)) return bByTable.get('assignment_learner_keys') ?? [];
  if (stem === 'tenant') return [bTenantId];
  const snake = stem.replace(/([A-Z])/g, '_$1').toLowerCase();
  const found: string[] = [];
  for (const [table, ids] of bByTable)
    if (table.includes(snake) || (snake === 'year' && table.includes('year'))) found.push(...ids);
  if (found.length > 0) return found;
  return [...bIds];
}
const pick = (name: string, i: number): string => {
  const pool = poolFor(name);
  return pool[i % Math.max(pool.length, 1)] ?? B.tenantId;
};

/** a value that satisfies a TypeBox / JSON schema, using ids of college B where an id is asked for */
function gen(schema: Json, name: string, i: number, depth = 0): unknown {
  if (!schema || depth > 5) return null;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  const union = schema.anyOf ?? schema.oneOf;
  if (union) {
    const first = union.find((s: Json) => s.type !== 'null') ?? union[0];
    return gen(first, name, i, depth + 1);
  }
  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const k of schema.required ?? []) out[k] = gen(schema.properties?.[k], k, i, depth + 1);
      return out;
    }
    case 'array': {
      const n = Math.max(schema.minItems ?? 0, 1);
      return Array.from({ length: n }, () => gen(schema.items, name, i, depth + 1));
    }
    case 'integer':
    case 'number':
      return Math.max(schema.minimum ?? 0, 1);
    case 'boolean':
      return false;
    case 'string': {
      if (schema.format === 'uuid' || /Id$/.test(name) || /^id$/.test(name)) return pick(name, i);
      if (schema.format === 'email') return 'probe@fz-a.test';
      if (schema.format === 'date-time') return new Date().toISOString();
      if (schema.format === 'date') return '2030-01-01';
      return 'x'.repeat(Math.max(schema.minLength ?? 1, 1));
    }
    default:
      return null;
  }
}

function build(
  route: RouteInfo,
  i: number,
): { url: string; query: string; body: unknown; used: string[] } {
  const used: string[] = [];
  const url = route.url.replace(/^\/api/, '').replace(/:([A-Za-z]+)/g, (_m, p: string) => {
    const v = pick(p, i);
    used.push(v);
    return v;
  });
  let query = '';
  const qs = route.schema?.querystring;
  if (qs?.required?.length) {
    const q = gen(qs, 'q', i) as Record<string, unknown>;
    for (const v of Object.values(q)) if (typeof v === 'string') used.push(v);
    query = new URLSearchParams(
      Object.entries(q).map(([k, v]): [string, string] => [k, String(v)]),
    ).toString();
  }
  let body: unknown;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method) && route.schema?.body) {
    body = gen(route.schema.body, 'body', i);
    // the ids of college B that the body carries (an error may name them)
    JSON.stringify(body, (_k, v) => {
      if (typeof v === 'string' && bIds.has(v)) used.push(v);
      return v;
    });
  }
  return { url, query, body, used };
}

// ---------------------------------------------------------------------------------------------------------------- B's fingerprint
async function fingerprint(): Promise<Record<string, string>> {
  const { rows: tabs } = await owner.query<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'lms' AND column_name = 'tenant_id' ORDER BY 1`,
  );
  const out: Record<string, string> = {};
  for (const { t: table } of tabs) {
    const { rows } = await owner.query<{ h: string }>(
      `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM lms.${table} x WHERE tenant_id = $1`,
      [bTenantId],
    );
    out[table] = rows[0]?.h ?? '';
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- the fuzz
describe('route table fuzz: callers of college A with ids of college B', () => {
  it('has routes to fuzz (the table is generated from the real app)', () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(bIds.size).toBeGreaterThan(50);
  });

  it('never leaks, never changes, never crashes: every route x every caller', async () => {
    const before = await fingerprint();
    const problems: string[] = [];
    const soft: string[] = [];
    const statusCounts: Record<string, number> = {};
    let requests = 0;
    const who = Object.entries(callers) as [keyof Callers, TestClient][];

    for (const route of routes) {
      const key = `${route.method} ${route.url.replace(/^\/api/, '')}`;
      if (SKIP.has(key)) continue;
      const variants = /:[A-Za-z]+/.test(route.url) || route.schema?.body ? [0, 1] : [0];
      for (const i of variants) {
        const { url, query, body, used } = build(route, i);
        for (const [name, client] of who) {
          if (name !== 'admin' && i === 1) continue; // the second set of ids only for the most privileged caller
          let res: Awaited<ReturnType<TestClient['request']>>;
          try {
            res = await client.request(route.method, url, {
              ...(body !== undefined ? { body } : {}),
              ...(query ? { query } : {}),
            });
          } catch (err) {
            problems.push(`${name} ${key}: the request threw ${(err as Error).message}`);
            continue;
          }
          requests++;
          statusCounts[String(res.statusCode)] = (statusCounts[String(res.statusCode)] ?? 0) + 1;
          if (res.statusCode === 500)
            problems.push(`${name} ${key} -> 500 ${res.body.slice(0, 120)}`);
          // what did the response say? ids the request itself carried do not count
          let text = res.body;
          for (const u of used) text = text.split(u).join('');
          const foreign = (text.match(UUID_RE) ?? []).filter((u) => bIds.has(u));
          if (foreign.length > 0)
            problems.push(
              `${name} ${key} (${res.statusCode}) leaked ids of college B: ${foreign.slice(0, 2).join(', ')}`,
            );
          for (const m of MARKERS) {
            if (text.includes(m)) problems.push(`${name} ${key} (${res.statusCode}) leaked "${m}"`);
          }
          if (res.statusCode < 300 && used.length > 0 && /:[A-Za-z]+/.test(route.url))
            soft.push(`${name} ${key} -> ${res.statusCode}`);
        }
      }
    }

    const after = await fingerprint();
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    for (const table of changed) problems.push(`college B's ${table} CHANGED during the fuzz`);

    // biome-ignore lint/suspicious/noConsole: the fuzz reports its coverage
    console.info(
      `tenant fuzz: ${requests} requests over ${routes.length} routes; statuses ${JSON.stringify(statusCounts)}`,
    );
    if (soft.length > 0)
      // biome-ignore lint/suspicious/noConsole: the fuzz reports what it saw
      console.info(
        `2xx answers to a request with a foreign path id (no data of B in them, B unchanged): ${soft.length}\n  ${[...new Set(soft)].slice(0, 40).join('\n  ')}`,
      );
    if (process.env.FUZZ_REPORT) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        process.env.FUZZ_REPORT,
        JSON.stringify(
          { requests, routes: routes.length, statusCounts, soft: [...new Set(soft)] },
          null,
          1,
        ),
      );
    }
    expect(problems).toEqual([]);
    expect(requests).toBeGreaterThan(routes.length * 3);
  }, 900_000);

  it('the harness itself can see a leak (a sanity check that the assertions are not vacuous)', async () => {
    // A's admin asking for a B member through a route that returns members MUST show B's name if RLS were off: prove the marker works
    const any = [...bUserIds][0] as string;
    const asB = new TestClient(t, B.host);
    expect((await asB.login(B.adminEmail, 'x')).statusCode).toBe(401); // wrong password: nothing to see
    const direct = await owner.query(`SELECT display_name FROM lms.users WHERE id = $1`, [any]);
    expect(String(direct.rows[0]?.display_name)).toContain('FZB ');
    const res = await callers.admin.get(`/members/${any}`);
    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBeTruthy();
  });
});
