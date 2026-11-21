import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { createDb, type Database } from '../src/db/client';
import { makeApp, type TestApp } from './app';
import { keyFromDb } from './assignments-helpers';
import { TestClient } from './client';
import { type Json, loginAs, ok, type Structure, structure, uniq } from './courses-helpers';
import {
  assignment,
  type Class,
  base as gbBase,
  gradebookClass,
  participantIds,
  quiz,
  releaseQuiz,
} from './gradebook-helpers';
import { expectPgError, SQLSTATE } from './helpers';
import { csv, FACULTY_HEADER, upload } from './imports-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  testAppDbOptions,
  testAppPool,
  testOwnerPool,
} from './support';

// DATA PROTECTION, step 14b-1, part 1: the display override. lms.member_identity is the ONE place that decides how a member is shown
// inside a college (migration 0060); every college-scoped reader of a name or an address goes through it (0061, the repositories).
//
// 1. The view itself: what it returns, and that a college sees ONLY its own members through it (hostile tenant ids, a user id of another
//    college, no tenant at all). The application can read overrides and never write them.
// 2. The sentinel sweep: two people (a learner and an instructor) with recognisable names and addresses are in real data (a quiz, an
//    assignment, a gradebook that was submitted and approved, an audit trail, a regrade, an accommodation, an extension). Every GET
//    route of the app is called with the real ids, as four kinds of caller. Before the override the sentinels DO appear (so the
//    check can see them); after it they appear in NO answer except the explicitly listed ones: the frozen gradebook record.
// 3. The search keys follow the override, a global rename does not undo it, a snapshot written after the override uses the pseudonym.

const SENTINELS_LEARNER = ['zqlena', 'quasar'];
const SENTINELS_INSTRUCTOR = ['zqivan', 'quokka'];
const PSEUDO_LEARNER = 'Former member L-1111';
const PSEUDO_INSTRUCTOR = 'Former member I-2222';

let owner: pg.Pool;
let t: TestApp;
let db: Database;
const routes: { method: string; url: string }[] = [];

beforeAll(async () => {
  owner = testOwnerPool(4);
  db = createDb(testAppDbOptions(2));
  t = makeApp({
    env: { RATE_LIMIT_MAX: '1000000', TENANT_CACHE_TTL_MS: '3600000' },
  });
  t.app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/docs') || route.schema?.hide === true) return;
    if (!route.url.startsWith('/api/')) return;
    for (const m of Array.isArray(route.method) ? route.method : [route.method])
      if (m === 'GET') routes.push({ method: m, url: route.url });
  });
});
afterAll(async () => {
  await t.close();
  await db.close();
  await owner.end();
});

async function override(tenantId: string, membershipId: string, pseudonym: string) {
  await owner.query(
    'INSERT INTO lms.membership_display_overrides (tenant_id, membership_id, pseudonym) VALUES ($1, $2, $3)',
    [tenantId, membershipId, pseudonym],
  );
}

// ------------------------------------------------------------------------------------------------------------------ 1. the view
interface IdentityRow {
  membership_id: string;
  user_id: string;
  tenant_id: string;
  display_name: string;
  email: string;
  erased: boolean;
}

describe('lms.member_identity', () => {
  let X: AuthFixture;
  let Y: AuthFixture;
  let sharedUser: string;
  let sharedInX: string;
  let sharedInY: string;

  beforeAll(async () => {
    X = await createAuthFixture(owner, 'ident-x');
    Y = await createAuthFixture(owner, 'ident-y');
    // one person with a membership in BOTH colleges
    sharedUser = newId();
    sharedInX = newId();
    sharedInY = newId();
    await owner.query(
      "INSERT INTO lms.users (id, email, display_name) VALUES ($1, 'shared.person@ident.test', 'Shared Person')",
      [sharedUser],
    );
    await owner.query(
      `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'member'), ($4, $5, $3, 'member')`,
      [sharedInX, X.tenantId, sharedUser, sharedInY, Y.tenantId],
    );
    await override(X.tenantId, sharedInX, 'Former member S-0001');
  });

  const identity = (tenantId: string, opts?: { userId: string }) =>
    db.withTenant(
      tenantId,
      async (tx) =>
        (
          await tx.execute(
            sql`SELECT membership_id, user_id, tenant_id, display_name, email, erased FROM lms.member_identity ORDER BY display_name`,
          )
        ).rows as unknown as IdentityRow[],
      opts,
    );

  it('shows the real name and address of a member, and the pseudonym with an EMPTY address (never NULL) of an erased one', async () => {
    const inX = await identity(X.tenantId);
    expect(inX.find((r) => r.user_id === sharedUser)).toMatchObject({
      display_name: 'Former member S-0001',
      email: '',
      erased: true,
      membership_id: sharedInX,
    });
    expect(inX.find((r) => r.user_id === X.memberUserId)).toMatchObject({
      display_name: 'Member',
      email: 'member@ident-x.test',
      erased: false,
    });
    // the SAME person in the other college is untouched: an override is per membership
    expect((await identity(Y.tenantId)).find((r) => r.user_id === sharedUser)).toMatchObject({
      display_name: 'Shared Person',
      email: 'shared.person@ident.test',
      erased: false,
    });
  });

  it('a college sees ONLY its own members through it', async () => {
    const inX = await identity(X.tenantId);
    const inY = await identity(Y.tenantId);
    expect(inX.every((r) => r.tenant_id === X.tenantId)).toBe(true);
    expect(inY.every((r) => r.tenant_id === Y.tenantId)).toBe(true);
    expect(inX.map((r) => r.user_id).sort()).toEqual(
      [X.adminUserId, X.memberUserId, sharedUser].sort(),
    );
    expect(inY.map((r) => r.user_id).sort()).toEqual(
      [Y.adminUserId, Y.memberUserId, sharedUser].sort(),
    );
    // asking for the other college's rows by id from inside this one finds nothing
    const foreign = await db.withTenant(
      X.tenantId,
      async (tx) =>
        (
          await tx.execute(
            sql`SELECT user_id FROM lms.member_identity WHERE tenant_id = ${Y.tenantId}::uuid OR user_id IN (${Y.adminUserId}::uuid, ${Y.memberUserId}::uuid)`,
          )
        ).rows,
    );
    expect(foreign).toEqual([]);
  });

  it('shows nothing under an unknown tenant, with no tenant, or with a user id of another college', async () => {
    expect(await identity(newId())).toEqual([]);
    const none = await db.withoutTenant(
      async (c) =>
        (await c.execute(sql`SELECT count(*)::int AS n FROM lms.member_identity`)).rows[0],
    );
    expect(none).toEqual({ n: 0 });
    // the user id of a member of Y as the SIGNED-IN user, inside college X: the users policy lets X see the row of the signed-in
    // user, but the view joins it to a membership of X, so nothing comes out
    const asY = await identity(X.tenantId, { userId: Y.memberUserId });
    expect(asY.some((r) => r.user_id === Y.memberUserId)).toBe(false);
    expect(asY.every((r) => r.tenant_id === X.tenantId)).toBe(true);
  });

  it('hostile tenant ids never reach the database as text, and a forged setting still shows only that tenant', async () => {
    for (const bad of [
      "x'; DROP TABLE lms.users; --",
      `${X.tenantId}' OR '1'='1`,
      '',
      'not-a-uuid',
    ]) {
      await expect(db.withTenant(bad, async () => 1)).rejects.toThrow();
    }
    // a raw lms_app connection that sets app.tenant_id itself sees exactly that tenant's members
    const raw = testAppPool(1);
    try {
      const c = await raw.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [Y.tenantId]);
        const r = await c.query('SELECT DISTINCT tenant_id FROM lms.member_identity');
        expect(r.rows.map((x: { tenant_id: string }) => x.tenant_id)).toEqual([Y.tenantId]);
        await c.query('ROLLBACK');
        // no tenant set: nothing, not even X's rows
        await c.query('BEGIN');
        const z = await c.query('SELECT count(*)::int AS n FROM lms.member_identity');
        expect(z.rows[0].n).toBe(0);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    } finally {
      await raw.end();
    }
  });

  it('the application can read the overrides of its own college and can never write, change or delete one', async () => {
    const count = (tenantId: string) =>
      db.withTenant(
        tenantId,
        async (tx) =>
          (await tx.execute(sql`SELECT count(*)::int AS n FROM lms.membership_display_overrides`))
            .rows[0] as { n: number },
      );
    expect(await count(X.tenantId)).toEqual({ n: 1 });
    expect(await count(Y.tenantId)).toEqual({ n: 0 });
    const raw = testAppPool(1);
    try {
      for (const stmt of [
        `INSERT INTO lms.membership_display_overrides (tenant_id, membership_id, pseudonym) VALUES ('${X.tenantId}', '${X.memberMembershipId}', 'x')`,
        "UPDATE lms.membership_display_overrides SET pseudonym = 'changed'",
        'DELETE FROM lms.membership_display_overrides',
      ]) {
        const c = await raw.connect();
        try {
          await c.query('BEGIN');
          await c.query("SELECT set_config('app.tenant_id', $1, true)", [X.tenantId]);
          await expectPgError(c.query(stmt), SQLSTATE.insufficientPrivilege);
          await c.query('ROLLBACK');
        } finally {
          c.release();
        }
      }
    } finally {
      await raw.end();
    }
  });

  it('a membership with an override cannot be deleted (history is not cascaded away)', async () => {
    await expectPgError(
      owner.query('DELETE FROM lms.tenant_memberships WHERE id = $1', [sharedInX]),
      SQLSTATE.foreignKeyViolation,
    );
  });

  it('the search keys follow the override, and a rename of the global user does not undo it', async () => {
    const keys = async (id: string) =>
      (
        await owner.query(
          'SELECT search_name, search_email FROM lms.tenant_memberships WHERE id = $1',
          [id],
        )
      ).rows[0];
    expect(await keys(sharedInX)).toEqual({
      search_name: 'former member s-0001',
      search_email: null,
    });
    await owner.query(
      "UPDATE lms.users SET display_name = 'Renamed Elsewhere', email = 'renamed.elsewhere@ident.test' WHERE id = $1",
      [sharedUser],
    );
    expect(await keys(sharedInX)).toEqual({
      search_name: 'former member s-0001',
      search_email: null,
    });
    // ... while the same person in the college WITHOUT an override follows the rename
    expect(await keys(sharedInY)).toEqual({
      search_name: 'renamed elsewhere',
      search_email: 'renamed.elsewhere@ident.test',
    });
  });
});

/** submit + approve a gradebook of one manual item (a locked version with one snapshot row per learner) */
async function approveGradebook(e: Class, admin: TestClient, ...pids: (string | undefined)[]) {
  const ic = e.instructor.client;
  const b = gbBase(e.offeringId);
  const cfg = ok(
    await ic.put(`${b}/categories`, {
      categories: [{ name: 'Tests', weight: 100, dropLowest: 0, missingPolicy: 'exclude' }],
    }),
  );
  const cat = cfg.categories[0].id as string;
  const g = ok(
    await ic.put(`${b}/items`, {
      items: [
        {
          source: 'manual',
          title: 'Test 1',
          categoryId: cat,
          points: 50,
          extraCredit: false,
          released: true,
        },
      ],
    }),
  );
  const item = (g.items as Json[]).find((i) => i.title === 'Test 1')?.id as string;
  ok(
    await ic.patch(`${b}/settings`, {
      weighted: true,
      outOf: 50,
      roundMode: 'half_up',
      roundDecimals: 0,
    }),
  );
  ok(
    await ic.put(`${b}/marks`, {
      cells: pids
        .filter((p): p is string => !!p)
        .map((p, i) => ({ itemId: item, participantId: p, points: String(40 - i * 10) })),
    }),
  );
  const scale = ok(
    await admin.post('/grade-scales', {
      name: uniq('Scale'),
      bands: [
        { minPercent: 0, label: 'RA', isPass: false },
        { minPercent: 50, label: 'C', isPass: true },
      ],
    }),
  );
  ok(await ic.patch(`${b}/settings`, { scaleId: scale.id }));
  ok(await ic.post(`${b}/submit`));
  ok(await admin.post(`${b}/approve`, { comment: 'ok' }));
}

// ------------------------------------------------------------------------------------------------------------------ 2. the sweep
describe('sentinel sweep: no college-scoped answer shows an overridden member', () => {
  let A: AuthFixture;
  let admin: TestClient;
  let st: Structure;
  let e: Class;
  let quizItem: Json;
  let essayItem: Json;
  let lena: Class['learners'][number];
  let omar: Class['learners'][number];
  let ivan: Class['instructor'];
  let ids: Record<string, string[]>;
  let callers: [string, TestClient][];

  beforeAll(async () => {
    A = await createAuthFixture(owner, 'ident-a');
    await t.app.ready();
    admin = await loginAs(t, A.host, A.adminEmail);
    st = await structure(admin);
    e = await gradebookClass(owner, t, A, admin, st, ['ZQLena Quasar', 'Omar Other']);
    [lena, omar] = e.learners as [typeof lena, typeof omar];
    ivan = e.instructor;
    // recognisable name AND address for the instructor (the learner's come from the helper: 'zqlena...@ident-a.test')
    await owner.query(
      "UPDATE lms.users SET display_name = 'ZQIvan Quokka', email = 'zqivan.quokka@ident-a.test' WHERE id = $1",
      [ivan.userId],
    );
    quizItem = await quiz(e, 'Quiz 1', [true, false]);
    await releaseQuiz(e, quizItem.id);
    essayItem = await assignment(owner, e, 'Essay', [80, 65], {
      release: true,
      dueInPast: true,
    });

    const [lenaPid, omarPid] = await participantIds(owner, e.offeringId, [lena, omar]);
    const ic = ivan.client;
    const assess = `/offerings/${e.offeringId}/items/${quizItem.id}/assessment`;
    ok(
      await ic.put(`${assess}/accommodations/${lenaPid}`, {
        extraMinutes: 15,
        reason: 'office approval',
      }),
    );
    ok(
      await ic.put(
        `/offerings/${e.offeringId}/items/${essayItem.id}/assignment/extensions/${lenaPid}`,
        { extendedDueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), reason: 'travel' },
      ),
    );
    // a regrade run by the instructor (the history names who ran it)
    const qid = (
      await owner.query('SELECT id FROM lms.questions WHERE tenant_id = $1 LIMIT 1', [A.tenantId])
    ).rows[0].id as string;
    ok(await ic.post(`${assess}/regrade`, { questionId: qid, action: 'credit', dryRun: false }));

    // the gradebook: submitted by the instructor, approved by the admin
    await approveGradebook(e, admin, lenaPid, omarPid);

    // an audit row whose actor is the instructor
    await owner.query(
      `INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, 'test.sentinel', 'user', $4, '{}')`,
      [newId(), A.tenantId, ivan.userId, lena.userId],
    );

    // the other places a person's name or address ends up (the inventory the DATABASE scan below pins):
    // an invite to an address (membership, token, audit row, queued mail), a failed sign-in, an import row
    ok(await admin.post('/auth/invites', { email: 'zqnora@ident-a.test', role: 'member' }));
    await new TestClient(t, A.host).login(lena.email, 'wrong password!!');
    ok(
      await upload(
        admin,
        'faculty',
        csv(FACULTY_HEADER, [['zqpia@ident-a.test', 'ZQPia Roe', 'EMP-ZQ1', 'NOPE']]),
      ),
    );

    const col = async (table: string) =>
      (
        await owner.query(`SELECT id FROM lms.${table} WHERE tenant_id = $1`, [A.tenantId])
      ).rows.map((r) => r.id as string);
    ids = {
      offeringId: [e.offeringId],
      courseId: [e.courseId],
      moduleId: [e.moduleId],
      itemId: [quizItem.id, essayItem.id],
      participantId: [lenaPid as string, omarPid as string],
      userId: [lena.userId, ivan.userId, omar.userId],
      learnerKey: [(await keyFromDb(owner, essayItem.id, lena)).key],
      scaleId: await col('grade_scales'),
      questionId: await col('questions'),
      attemptId: await col('attempts'),
    };
    callers = [
      ['admin', admin],
      ['instructor', ivan.client],
      ['assistant', e.assistant.client],
      ['learner', omar.client],
    ];
  }, 300_000);

  /** values for a path parameter: by its name, and for a bare `:id` by the segment before it */
  function valuesFor(name: string, before: string): string[] {
    const byParent: Record<string, string> = {
      offerings: 'offeringId',
      courses: 'courseId',
      items: 'itemId',
      members: 'userId',
    };
    const key =
      name === 'id'
        ? byParent[before]
        : name === 'key' || name === 'learnerKey'
          ? 'learnerKey'
          : name;
    return (key ? ids[key] : undefined) ?? [];
  }

  function urlsOf(route: string): string[] {
    const parts = route.replace(/^\/api/, '').split('/');
    let combos: string[][] = [[]];
    for (const [i, seg] of parts.entries()) {
      if (!seg.startsWith(':')) {
        combos = combos.map((c) => [...c, seg]);
        continue;
      }
      const vals = valuesFor(seg.slice(1), parts[i - 1] ?? '');
      if (vals.length === 0) return [];
      combos = vals.flatMap((v) => combos.map((c) => [...c, v]));
    }
    return combos.map((c) => c.join('/'));
  }

  async function sweep() {
    const out: { url: string; caller: string; status: number; body: string }[] = [];
    let skipped = 0;
    for (const r of routes) {
      if (/storage|\/play\/|\/docs|metrics|download|\.zip|health|unsubscribe/.test(r.url)) continue;
      const urls = urlsOf(r.url);
      if (urls.length === 0) {
        skipped++;
        continue;
      }
      for (const url of urls) {
        for (const [caller, client] of callers) {
          const res = await client.get(url);
          out.push({ url, caller, status: res.statusCode, body: res.body });
        }
      }
    }
    return { out, skipped };
  }

  const hits = (body: string, tokens: string[]) => {
    const low = body.toLowerCase();
    return tokens.some((s) => low.includes(s));
  };
  const lenaTokens = () => [...SENTINELS_LEARNER, lena.email.toLowerCase()];
  const ivanTokens = () => [...SENTINELS_INSTRUCTOR];

  /** every text / jsonb / inet column of every table of schema lms, searched for the tokens (owner connection: sees all colleges) */
  async function whereStored(tokens: string[]): Promise<Record<string, number>> {
    const cols = (
      await owner.query(
        `SELECT c.table_name, c.column_name FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
          WHERE c.table_schema = 'lms' AND c.data_type IN ('text', 'character varying', 'USER-DEFINED', 'jsonb', 'json', 'inet')
            AND c.table_name <> 'schema_migrations' ORDER BY 1, 2`,
      )
    ).rows as { table_name: string; column_name: string }[];
    const out: Record<string, number> = {};
    for (const { table_name: tbl, column_name: col } of cols) {
      const r = await owner.query(
        `SELECT count(*)::int AS n FROM lms."${tbl}" WHERE "${col}"::text ILIKE ANY ($1)`,
        [tokens.map((x) => `%${x}%`)],
      );
      if (r.rows[0].n > 0) out[`${tbl}.${col}`] = r.rows[0].n;
    }
    return out;
  }

  it('has teeth: before the override the sentinels ARE in the answers (the sweep can see them)', async () => {
    const { out, skipped } = await sweep();
    expect(out.length).toBeGreaterThan(150);
    const withLena = out.filter((r) => hits(r.body, lenaTokens()));
    const withIvan = out.filter((r) => hits(r.body, ivanTokens()));
    const shapes = (rs: typeof out) =>
      new Set(rs.map((r) => r.url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')));
    // WHERE THE PEOPLE ARE STORED, everywhere in the database (every text / jsonb / inet column, all colleges). This list is the
    // inventory the erasure (next part) must handle; a NEW place that holds a name or an address fails here until it is reviewed.
    expect(
      Object.keys(await whereStored([...lenaTokens(), ...ivanTokens(), 'zqnora', 'zqpia'])).sort(),
    ).toEqual([
      'email_outbox.to_email', // queued and sent mail: erasure blanks the address and the params of the member's rows
      'gradebook_snapshot_rows.display_name', // the frozen gradebook: kept as the academic record (counsel decides)
      'gradebook_snapshot_rows.email',
      'import_rows.email', // staged import rows: purged 7 days after the import ended; erasure scrubs rows of the member's address
      'import_rows.full_name',
      'import_rows.raw',
      'tenant_memberships.search_email', // trigger copies for prefix search: follow the override (tested below)
      'tenant_memberships.search_name',
      'users.display_name', // the GLOBAL account: erased only when the person has no membership left (account level)
      'users.email',
    ]);
    expect(shapes(withLena).size).toBeGreaterThan(6);
    expect(shapes(withIvan).size).toBeGreaterThan(3);
    expect(skipped).toBeLessThan(routes.length / 2);
  }, 300_000);

  it('after the override: in NO answer, except the frozen gradebook record', async () => {
    const memberships = (
      await owner.query('SELECT id, user_id FROM lms.tenant_memberships WHERE tenant_id = $1', [
        A.tenantId,
      ])
    ).rows as { id: string; user_id: string }[];
    const mid = (u: string) => memberships.find((m) => m.user_id === u)?.id as string;
    await override(A.tenantId, mid(lena.userId), PSEUDO_LEARNER);
    await override(A.tenantId, mid(ivan.userId), PSEUDO_INSTRUCTOR);

    const { out } = await sweep();
    const found = out.filter((r) => hits(r.body, [...lenaTokens(), ...ivanTokens()]));
    // THE ALLOWED HITS, listed: the approved gradebook's snapshot (the college's academic record keeps what it recorded: counsel
    // decides, docs/data-retention.md) is read through the two export routes.
    // The CALLER'S OWN account: the instructor (an overridden member in this test) is still signed in and reads their own session
    //    (/auth/me) and their own address status. An executed erasure revokes the member's sessions in the same statement (built in the
    //    next part), so a real erased member is never a caller; sign-in and the session read the global account on purpose.
    const allowed = (url: string, caller: string) =>
      /\/gradebook\/export\.(csv|xlsx)$/.test(url) ||
      (caller === 'instructor' && (url === '/auth/me' || url === '/me/email-status'));
    const unexpected = found.filter((r) => !allowed(r.url, r.caller));
    expect(
      unexpected.map((r) => `${r.caller} ${r.url} (${r.status})`),
      'these answers still show an overridden member: a reader bypasses lms.member_identity',
    ).toEqual([]);
    // THE DATABASE after the override: what still holds the two people, each with its reason (everything else was rewritten)
    expect(Object.keys(await whereStored([...lenaTokens(), ...ivanTokens()])).sort()).toEqual([
      'email_outbox.to_email', // erasure execution blanks it (next part); not part of the display override
      'gradebook_snapshot_rows.display_name', // frozen record of an approval made BEFORE the override
      'gradebook_snapshot_rows.email',
      'users.display_name', // the global account
      'users.email',
    ]);
    // the exemptions are real (each one is used), so a stale one is noticed
    expect(found.some((r) => /export\.csv$/.test(r.url))).toBe(true);
    expect(found.some((r) => r.url === '/auth/me')).toBe(true);
    // ... and the pseudonyms are what is shown instead
    expect(out.some((r) => r.body.includes(PSEUDO_LEARNER))).toBe(true);
    expect(out.some((r) => r.body.includes(PSEUDO_INSTRUCTOR))).toBe(true);
  }, 300_000);

  it('searching the members list by the real name finds nobody; by the pseudonym finds the member', async () => {
    expect(ok(await admin.get('/members?q=zqlena&limit=50')).items).toEqual([]);
    const byPseudo = ok(await admin.get('/members?q=former%20member&limit=50'));
    expect(byPseudo.items.map((m: Json) => m.displayName).sort()).toEqual(
      [PSEUDO_INSTRUCTOR, PSEUDO_LEARNER].sort(),
    );
    const byEmail = ok(
      await admin.get(
        `/members?q=${encodeURIComponent(lena.email.toLowerCase().slice(0, 8))}&limit=50`,
      ),
    );
    expect(byEmail.items).toEqual([]);
    for (const m of byPseudo.items) expect(m.email).toBe('');
  });

  it('the global account row is untouched (the override is per college)', async () => {
    const r = await owner.query('SELECT display_name FROM lms.users WHERE id = $1', [lena.userId]);
    expect(r.rows[0].display_name).toBe('ZQLena Quasar');
  });
});

// ------------------------------------------------------------------------------------------------------------------ 3. snapshot
describe('a gradebook approved AFTER an override is snapshotted under the pseudonym', () => {
  it('writes the pseudonym and an empty address into the frozen record (nothing re-captures a real name)', async () => {
    const F = await createAuthFixture(owner, 'ident-snap');
    await t.app.ready();
    const admin = await loginAs(t, F.host, F.adminEmail);
    const st = await structure(admin);
    const e = await gradebookClass(owner, t, F, admin, st, ['SnapErased One', 'SnapKept Two']);
    const [one, two] = e.learners as [Class['learners'][number], Class['learners'][number]];
    const pids = await participantIds(owner, e.offeringId, [one, two]);
    await override(F.tenantId, one.membershipId, 'Former member S-7777');
    await approveGradebook(e, admin, ...pids);
    const rows = (
      await owner.query(
        `SELECT s.display_name, s.email FROM lms.gradebook_snapshot_rows s
          JOIN lms.gradebook_versions v ON v.id = s.version_id JOIN lms.gradebooks g ON g.id = v.gradebook_id
         WHERE g.offering_id = $1 ORDER BY s.display_name`,
        [e.offeringId],
      )
    ).rows;
    expect(rows.map((r) => r.display_name)).toEqual(['Former member S-7777', 'SnapKept Two']);
    expect(rows.find((r) => r.display_name === 'Former member S-7777')?.email).toBe('');
    expect(JSON.stringify(rows)).not.toMatch(/SnapErased/i);
  }, 180_000);
});
