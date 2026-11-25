import { appendFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reapplyErasures } from '../src/cli/privacy-reapply-erasures';
import { makeApp, type TestApp, testEnv } from './app';
import type { TestClient } from './client';
import { loginAs, ok, person } from './courses-helpers';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// DATA PROTECTION, step 14b-1: THE LEDGER ENTRY IS DURABLE.
// The execution commits in the database FIRST, the ledger entry (ids only, outside the database) is written AFTER the commit. A crash or a
// failure in between must never lose the entry: the request carries a persisted flag (`ledger_at`, NULL until the line is written and
// flushed) and every scan writes the lines that are still missing. Also: a torn last line (the process died while appending) is cut off,
// and the re-application command is idempotent against a ledger with duplicate entries.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let ledgerDir: string;
const FILE = () => join(ledgerDir, 'erasure-ledger.jsonl');
const svc = () => t.app.modules.privacy.erasureService;
const envOverrides = () => ({
  RATE_LIMIT_MAX: '1000000',
  RATE_LIMIT_LOGIN_PER_IP: '100000',
  LOGIN_MAX_ATTEMPTS: '50',
  TENANT_CACHE_TTL_MS: '3600000',
  ERASURE_LEDGER_DIR: ledgerDir,
  SUPPRESSION_HASH_KEYS: `k2:${'b'.repeat(40)}`,
});

beforeAll(async () => {
  owner = testOwnerPool(4);
  ledgerDir = await mkdtemp(join(tmpdir(), 'lms-ledger-dur-'));
  t = makeApp({ env: envOverrides() });
  A = await createAuthFixture(owner, 'led-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
}, 120_000);

afterAll(async () => {
  await t.close();
  await owner.end();
  await rm(ledgerDir, { recursive: true, force: true });
});

/** a member whose college erasure is approved and due */
async function dueMember(name: string) {
  const m = await person(owner, t, A, name);
  const id = ok(await m.client.post('/me/erasure', { password: TEST_PASSWORD })).request
    .id as string;
  ok(await admin.post(`/privacy/erasure-requests/${id}/approve`, {}));
  await owner.query(
    "UPDATE lms.erasure_requests SET grace_until = '2026-01-01T00:00:00Z' WHERE id = $1",
    [id],
  );
  return { m, id };
}
const req = async (id: string) =>
  (await owner.query('SELECT status, ledger_at FROM lms.erasure_requests WHERE id = $1', [id]))
    .rows[0];
const entries = async () =>
  (await readFile(FILE(), 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

describe('the ledger entry survives a failure between the commit and the write', () => {
  it('the writer fails after the commit: the erasure is done, ledger_at stays NULL, and the next scan writes the entry and sets it', async () => {
    const { m, id } = await dueMember('Durable Dan');
    // the ledger cannot be written: its file is a DIRECTORY (every append fails), exactly as a full disk or a gone mount would
    const real = `${FILE()}.real`;
    await rename(FILE(), real).catch(() => undefined);
    await mkdir(FILE(), { recursive: true });
    const first = await svc().scan();
    expect(first.erased).toBeGreaterThanOrEqual(1);
    expect(first.ledger).toBe(0); // nothing written
    let r = await req(id);
    expect(r.status).toBe('done'); // the database commit happened
    expect(r.ledger_at).toBeNull(); // ... and the database KNOWS the entry is still owed
    // the ledger comes back; the scan that follows writes what is missing
    await rm(FILE(), { recursive: true, force: true });
    await rename(real, FILE()).catch(() => undefined);
    const second = await svc().scan();
    expect(second.ledger).toBeGreaterThanOrEqual(1);
    r = await req(id);
    expect(r.ledger_at).not.toBeNull();
    expect((await entries()).filter((e) => e.requestId === id)).toEqual([
      {
        v: 1,
        requestId: id,
        tenantId: A.tenantId,
        membershipId: m.membershipId,
        userId: m.userId,
        level: 'college',
        at: expect.any(String),
      },
    ]);
    // and nothing is written twice by later scans
    await svc().scan();
    expect((await entries()).filter((e) => e.requestId === id)).toHaveLength(1);
  });

  it('a process that died while appending leaves a torn last line: it is ignored, the owed entry is written on a fresh line, the file stays readable', async () => {
    const { id } = await dueMember('Durable Tess');
    await appendFile(FILE(), '{"v":1,"requestId":"0190abc'); // no newline: torn
    expect(await svc().writeLedger()).toBe(0); // nothing is owed yet (not executed)
    await svc().scan();
    expect((await req(id)).ledger_at).not.toBeNull();
    const text = await readFile(FILE(), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('0190abc');
    expect((await entries()).filter((e) => e.requestId === id)).toHaveLength(1);
    // the reader accepts the whole file
    await expect(svc().reapplyFromLedger()).resolves.toBeDefined();
  });

  it('the account level has the same persisted flag and the same retry', async () => {
    const m = await person(owner, t, A, 'Durable Acc');
    await owner.query("UPDATE lms.tenant_memberships SET status = 'removed' WHERE user_id = $1", [
      m.userId,
    ]);
    await owner.query(
      "INSERT INTO lms.users (id, email, display_name, is_platform_admin) VALUES (lms.uuid_v7(), 'led-p1@led.test', 'P1', true), (lms.uuid_v7(), 'led-p2@led.test', 'P2', true) ON CONFLICT DO NOTHING",
    );
    const ids = (
      await owner.query(
        "SELECT id FROM lms.users WHERE email IN ('led-p1@led.test', 'led-p2@led.test') ORDER BY email",
      )
    ).rows.map((r) => r.id as string);
    const filed = (
      await owner.query('SELECT lms.privacy_account_platform_request($1, $2, NULL, now()) AS r', [
        ids[0],
        m.email,
      ])
    ).rows[0].r;
    expect(filed.result).toBe('ok');
    const id = filed.request.id as string;
    await owner.query(
      "SELECT lms.privacy_account_platform_decide($1, $2, 'approve', now(), NULL)",
      [ids[1], id],
    );
    await owner.query(
      "UPDATE lms.account_erasure_requests SET grace_until = '2026-01-01T00:00:00Z' WHERE id = $1",
      [id],
    );
    const real = `${FILE()}.real`;
    await rename(FILE(), real);
    await mkdir(FILE(), { recursive: true });
    expect((await svc().scan()).accountsErased).toBe(1);
    const row = async () =>
      (
        await owner.query(
          'SELECT status, ledger_at FROM lms.account_erasure_requests WHERE id = $1',
          [id],
        )
      ).rows[0];
    expect(await row()).toMatchObject({ status: 'done', ledger_at: null });
    await rm(FILE(), { recursive: true, force: true });
    await rename(real, FILE());
    await svc().scan();
    expect((await row()).ledger_at).not.toBeNull();
    expect((await entries()).filter((e) => e.requestId === id)).toEqual([
      { v: 1, requestId: id, userId: m.userId, level: 'account', at: expect.any(String) },
    ]);
  });
});

describe('the re-application command is idempotent against a ledger with duplicate entries', () => {
  it('the same entry many times, and the same person under two request ids: erased once, no error, a second run changes nothing', async () => {
    const { m, id } = await dueMember('Dup Dora');
    await svc().scan();
    const own = (await entries()).find((e) => e.requestId === id);
    expect(own).toBeDefined();
    // duplicates: the same line three more times, and the same person under a different request id
    for (let i = 0; i < 3; i++) await appendFile(FILE(), `${JSON.stringify(own)}\n`);
    await appendFile(
      FILE(),
      `${JSON.stringify({ ...own, requestId: '01a20000-0000-7000-8000-00000000d00d' })}\n`,
    );
    expect(await entries()).toEqual(expect.arrayContaining([own]));
    // the database is back to the state before the erasure (a restore): the membership is active again, the override is gone
    await owner.query('DELETE FROM lms.membership_display_overrides WHERE membership_id = $1', [
      m.membershipId,
    ]);
    await owner.query('DELETE FROM lms.erasure_requests WHERE membership_id = $1', [
      m.membershipId,
    ]);
    await owner.query("UPDATE lms.tenant_memberships SET status = 'active' WHERE id = $1", [
      m.membershipId,
    ]);
    const env = testEnv(envOverrides());
    const first = await reapplyErasures(env);
    expect(first.reapplied).toBeGreaterThanOrEqual(1);
    expect(
      Number(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM lms.membership_display_overrides WHERE membership_id = $1',
            [m.membershipId],
          )
        ).rows[0].n,
      ),
    ).toBe(1);
    const second = await reapplyErasures(env);
    expect(second.reapplied).toBe(0);
    expect(
      Number(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM lms.membership_display_overrides WHERE membership_id = $1',
            [m.membershipId],
          )
        ).rows[0].n,
      ),
    ).toBe(1);
    // exactly one request row for that membership (the reapplication re-created it once, the duplicate id did nothing)
    expect(
      Number(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM lms.erasure_requests WHERE membership_id = $1 AND status = 'done'",
            [m.membershipId],
          )
        ).rows[0].n,
      ),
    ).toBe(1);
  });
});
