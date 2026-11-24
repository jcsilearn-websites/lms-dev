import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { expectPgError, SQLSTATE } from './helpers';
import { type AuthFixture, createAuthFixture, testAppPool, testOwnerPool } from './support';

// THE AUDIT LOG IS APPEND-ONLY, with ONE narrow exception (migration 0064): privacy_scrub_audit removes the allowlisted keys from the rows
// ABOUT an erased member, inside the transaction of an EXECUTING erasure request, and does nothing else. This file proves how narrow it is:
//   - lms_app cannot UPDATE or DELETE, whatever it sets;
//   - the owner cannot either, except through the exception;
//   - the exception works only for an executing request, of the same college, for a row about that member, and only for the removal of the
//     allowlisted keys (nothing else may change, nothing is deleted);
//   - only privacy_scrub_audit sets the switch, and nobody but the database's own functions can call it.

let owner: pg.Pool;
let app: pg.Pool;
let A: AuthFixture;
let B: AuthFixture;

beforeAll(async () => {
  owner = testOwnerPool(4);
  app = testAppPool(2);
  A = await createAuthFixture(owner, 'agd-a');
  B = await createAuthFixture(owner, 'agd-b');
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

const SCRUBBED = (m: Record<string, unknown>) =>
  owner
    .query('SELECT lms.audit_scrub_metadata($1::jsonb) AS m', [JSON.stringify(m)])
    .then((r) => r.rows[0].m);

async function auditRow(
  tenantId: string,
  actor: string | null,
  target: string,
  meta: Record<string, unknown>,
) {
  const id = newId();
  await owner.query(
    "INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, 'test.guard', 'x', $4, $5::jsonb)",
    [id, tenantId, actor, target, JSON.stringify(meta)],
  );
  return id;
}
async function request(
  f: AuthFixture,
  status: string,
  userId = f.memberUserId,
  membershipId = f.memberMembershipId,
) {
  // one open request per membership: close the ones an earlier case of this file left
  await owner.query(
    "UPDATE lms.erasure_requests SET status = 'cancelled' WHERE membership_id = $1 AND status IN ('pending_approval', 'approved', 'executing')",
    [membershipId],
  );
  const id = newId();
  await owner.query(
    `INSERT INTO lms.erasure_requests (id, tenant_id, membership_id, user_id, status, source, requested_at, grace_until, approved_by)
     VALUES ($1, $2, $3, $4, $5, 'member', now(), now(), $6)`,
    [id, f.tenantId, membershipId, userId, status, f.adminUserId],
  );
  return id;
}

/** runs `sql` in a transaction of the owner with the scrub switch set to `setting` (or not set), always rolled back */
async function underSwitch(setting: string | null, sql: string, params: unknown[] = []) {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    if (setting !== null)
      await c.query("SELECT set_config('lms.audit_scrub_request', $1, true)", [setting]);
    return await c.query(sql, params);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
const FORBIDDEN = /append-only|never deleted|permission denied/;

describe('lms_app can neither update nor delete an audit row, whatever it sets', () => {
  it('UPDATE and DELETE are refused by privilege, also with the scrub switch set and an executing request in place', async () => {
    const id = await auditRow(A.tenantId, A.memberUserId, A.memberUserId, {
      ip: '10.0.0.1',
      keep: 1,
    });
    const req = await request(A, 'executing');
    for (const stmt of [
      "UPDATE lms.audit_log SET metadata = '{}'::jsonb WHERE id = $1",
      'DELETE FROM lms.audit_log WHERE id = $1',
    ]) {
      const c = await app.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [A.tenantId]);
        await c.query("SELECT set_config('lms.audit_scrub_request', $1, true)", [req]);
        await expectPgError(c.query(stmt, [id]), SQLSTATE.insufficientPrivilege);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    }
    const r = await owner.query('SELECT metadata FROM lms.audit_log WHERE id = $1', [id]);
    expect(r.rows[0].metadata).toEqual({ ip: '10.0.0.1', keep: 1 });
  });

  it('the scrub function and the core of the erasure have NO execute privilege for lms_app or anybody else', async () => {
    for (const fn of [
      'lms.privacy_scrub_audit(uuid)',
      'lms.privacy_erase_core(uuid, uuid, text, bytea, text)',
      'lms.privacy_suppression_seal(text, bytea, text, boolean)',
      'lms.audit_log_guard()',
    ]) {
      const r = await owner.query(
        "SELECT has_function_privilege('lms_app', $1, 'EXECUTE') AS app, has_function_privilege('public', $1, 'EXECUTE') AS pub, has_function_privilege('authenticated', $1, 'EXECUTE') AS auth",
        [fn],
      );
      expect(r.rows[0], fn).toEqual({ app: false, pub: false, auth: false });
    }
    await expectPgError(
      app.query('SELECT lms.privacy_scrub_audit($1)', [newId()]),
      SQLSTATE.insufficientPrivilege,
    );
    await expectPgError(
      app.query("SELECT lms.privacy_erase_core($1, $2, 'x', '\\x00', 'k')", [A.tenantId, newId()]),
      SQLSTATE.insufficientPrivilege,
    );
  });
});

describe('the owner cannot rewrite or delete the audit log either, except through the scrub', () => {
  it('a plain UPDATE and a plain DELETE are refused by the trigger', async () => {
    const id = await auditRow(A.tenantId, A.memberUserId, A.memberUserId, { ip: '10.0.0.2' });
    await expect(
      owner.query("UPDATE lms.audit_log SET action = 'changed' WHERE id = $1", [id]),
    ).rejects.toThrow(FORBIDDEN);
    await expect(
      owner.query("UPDATE lms.audit_log SET metadata = '{}'::jsonb WHERE id = $1", [id]),
    ).rejects.toThrow(FORBIDDEN);
    await expect(owner.query('DELETE FROM lms.audit_log WHERE id = $1', [id])).rejects.toThrow(
      FORBIDDEN,
    );
    expect((await owner.query('SELECT 1 FROM lms.audit_log WHERE id = $1', [id])).rowCount).toBe(1);
  });

  it('naming a request is not enough: the request must be EXECUTING, in the same college, and the row must be about its member', async () => {
    const mine = await auditRow(A.tenantId, A.memberUserId, A.memberUserId, {
      ip: '10.0.0.3',
      keep: 1,
    });
    const other = await auditRow(A.tenantId, A.adminUserId, A.adminUserId, {
      ip: '10.0.0.4',
      keep: 1,
    });
    const scrub = (id: string): [string, unknown[]] => [
      'UPDATE lms.audit_log SET metadata = lms.audit_scrub_metadata(metadata) WHERE id = $1',
      [id],
    ];
    const executing = await request(A, 'executing');
    const approved = await request(A, 'approved', A.adminUserId, A.adminMembershipId);
    const otherCollege = await request(B, 'executing');

    // no setting, a made-up one, one that is not a UUID
    for (const setting of [null, newId(), 'not-a-uuid', '']) {
      await expect(underSwitch(setting, ...scrub(mine)), String(setting)).rejects.toThrow(
        FORBIDDEN,
      );
    }
    // a request that is not executing, or of another college
    await expect(
      underSwitch(approved, ...scrub(other)),
      'a request that is not executing',
    ).rejects.toThrow(FORBIDDEN);
    await expect(underSwitch(otherCollege, ...scrub(mine)), 'another college').rejects.toThrow(
      FORBIDDEN,
    );
    // an executing request, but a row that is not about its member
    await expect(
      underSwitch(executing, ...scrub(other)),
      'a row about someone else',
    ).rejects.toThrow(FORBIDDEN);
  });

  it('and even then only the allowlisted keys may go: no other column, no other key, no other change, never a DELETE', async () => {
    const id = await auditRow(A.tenantId, A.memberUserId, A.memberUserId, {
      ip: '10.0.0.5',
      email: 'x@y.test',
      keep: 1,
      after: { phone: '+91 98765 43210', section_id: 's' },
    });
    const executing = await request(A, 'executing');
    const bad: [string, string][] = [
      ['another column', "UPDATE lms.audit_log SET action = 'x' WHERE id = $1"],
      ['the actor', 'UPDATE lms.audit_log SET actor_user_id = NULL WHERE id = $1'],
      [
        'a key that is not on the list',
        "UPDATE lms.audit_log SET metadata = metadata - 'keep' - 'ip' - 'email' WHERE id = $1",
      ],
      [
        'a changed value',
        "UPDATE lms.audit_log SET metadata = jsonb_set(lms.audit_scrub_metadata(metadata), '{keep}', '2') WHERE id = $1",
      ],
      [
        'an added key',
        'UPDATE lms.audit_log SET metadata = lms.audit_scrub_metadata(metadata) || \'{"new":1}\'::jsonb WHERE id = $1',
      ],
      ['half of the scrub', "UPDATE lms.audit_log SET metadata = metadata - 'ip' WHERE id = $1"],
      ['a DELETE', 'DELETE FROM lms.audit_log WHERE id = $1'],
    ];
    for (const [what, sql] of bad)
      await expect(underSwitch(executing, sql, [id]), what).rejects.toThrow(FORBIDDEN);
    // the scrub itself: exactly the allowlist goes, inside before / after only the profile fields
    const ok = await underSwitch(
      executing,
      'UPDATE lms.audit_log SET metadata = lms.audit_scrub_metadata(metadata) WHERE id = $1 RETURNING id, metadata',
      [id],
    );
    expect(ok.rows[0]).toEqual({ id, metadata: { keep: 1, after: { section_id: 's' } } });
    // (it was rolled back: the row is untouched, and still there)
    expect(
      (await owner.query('SELECT metadata FROM lms.audit_log WHERE id = $1', [id])).rows[0]
        .metadata,
    ).toMatchObject({ ip: '10.0.0.5', email: 'x@y.test' });
  });

  it('the allowlist is what it says (and the helper never invents or changes anything)', async () => {
    expect(
      await SCRUBBED({
        ip: '1',
        email: 'e',
        toEmail: 't',
        address: 'a',
        recipient: 'r',
        keep: { ip: 'nested stays' },
      }),
    ).toEqual({ keep: { ip: 'nested stays' } });
    expect(
      await SCRUBBED({
        before: {
          phone: 'p',
          designation: 'd',
          register_number: 'r',
          employee_id: 'e',
          registerNumber: 'r',
          employeeId: 'e',
          role: 'member',
        },
        after: 'text',
      }),
    ).toEqual({ before: { role: 'member' }, after: 'text' });
    expect(await SCRUBBED({})).toEqual({});
    expect(await SCRUBBED({ userId: 'u', role: 'x' })).toEqual({ userId: 'u', role: 'x' });
  });

  it('only privacy_scrub_audit sets the switch, and only the guard reads it', async () => {
    const r = await owner.query(
      "SELECT p.proname, p.prosrc ~ 'set_config\\(''lms.audit_scrub_request''' AS sets, p.prosrc ~ 'audit_scrub_request' AS mentions FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'lms' AND p.prosrc ~ 'audit_scrub_request' ORDER BY 1",
    );
    expect(r.rows.filter((x) => x.sets).map((x) => x.proname)).toEqual(['privacy_scrub_audit']);
    expect(r.rows.map((x) => x.proname)).toEqual(['audit_log_guard', 'privacy_scrub_audit']);
    // the one function that sets it refuses a request that is not executing
    await expect(
      owner.query('SELECT lms.privacy_scrub_audit($1)', [
        await request(A, 'approved', A.adminUserId, A.adminMembershipId),
      ]),
    ).rejects.toThrow(/not executing/);
    await expect(owner.query('SELECT lms.privacy_scrub_audit($1)', [newId()])).rejects.toThrow(
      /not executing/,
    );
  });

  it('no application code or migration after 0064 names the switch', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const walk = async (dir: string): Promise<string[]> =>
      (await readdir(dir, { withFileTypes: true })).flatMap((d) =>
        d.isDirectory() ? [] : [path.join(dir, d.name)],
      );
    const migrations = await walk(path.resolve(import.meta.dirname, '../migrations'));
    const hits: string[] = [];
    for (const f of migrations)
      if ((await readFile(f, 'utf8')).includes('audit_scrub_request')) hits.push(path.basename(f));
    expect(hits).toEqual(['0064_erasure_execute.sql']);
    const src = await readdir(path.resolve(import.meta.dirname, '../src'), { recursive: true });
    for (const f of src.filter((x) => x.endsWith('.ts'))) {
      const text = await readFile(path.resolve(import.meta.dirname, '../src', f), 'utf8');
      expect(text.includes('audit_scrub_request'), f).toBe(false);
    }
  });
});

describe('a scrub never deletes: the rows of an erased member are all still there, with their ids', () => {
  it('counts and ids of the rows about a member are the same before and after a real erasure (executed in the erasure tests)', async () => {
    // the real flow is test/privacy.erasure.execute.test.ts (it asserts `count >= before`); here the helper-level guarantee:
    const before = Number(
      (await owner.query('SELECT count(*)::int AS n FROM lms.audit_log')).rows[0].n,
    );
    const executing = await request(A, 'executing');
    const id = await auditRow(A.tenantId, A.memberUserId, A.memberUserId, {
      ip: '10.0.0.6',
      keep: 1,
    });
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('lms.audit_scrub_request', $1, true)", [executing]);
      const u = await c.query(
        'UPDATE lms.audit_log SET metadata = lms.audit_scrub_metadata(metadata) WHERE id = $1',
        [id],
      );
      expect(u.rowCount).toBe(1);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(
      Number((await owner.query('SELECT count(*)::int AS n FROM lms.audit_log')).rows[0].n),
    ).toBe(before + 1);
    expect(
      (await owner.query('SELECT metadata FROM lms.audit_log WHERE id = $1', [id])).rows[0]
        .metadata,
    ).toEqual({ keep: 1 });
    // the request row of this test stays 'executing' in a TRUNCATEd-per-file database: nothing leaks to other files
  });
});
