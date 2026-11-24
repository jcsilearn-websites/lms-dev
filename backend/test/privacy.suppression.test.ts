import { createHmac, hkdfSync } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { expectPgError, SQLSTATE } from './helpers';
import { testAppPool, testOwnerPool } from './support';

// The suppression of an address after its owner is erased: kept as the KEYED hash (computed by the application, never by the database).
// College level keeps the plain address beside it (the account still lives and can be invited elsewhere); account level (next part)
// drops the plain address: the placeholder cannot match any address. The key ids in use are listed, for rotation.

let owner: pg.Pool;
let app: pg.Pool;
beforeAll(() => {
  owner = testOwnerPool();
  app = testAppPool(1);
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

const hmac = (secret: string, address: string) =>
  createHmac('sha256', Buffer.from(hkdfSync('sha256', secret, '', 'lms.suppression-hash', 32)))
    .update(address)
    .digest();
const seal = (email: string, hash: Buffer, kid: string, drop: boolean) =>
  owner
    .query('SELECT lms.privacy_suppression_seal($1, $2, $3, $4) AS n', [email, hash, kid, drop])
    .then((r) => Number(r.rows[0].n));
const row = async (email: string) =>
  (
    await owner.query(
      "SELECT email, encode(email_hash, 'hex') AS h, email_hash_kid FROM lms.email_suppressions WHERE email = $1 OR email_hash = decode($2, 'hex')",
      [email, hmac('s'.repeat(40), email).toString('hex')],
    )
  ).rows;

describe('privacy_suppression_seal', () => {
  it('stores the keyed hash and its key id beside the plain address (college level); the suppression keeps working for a live address', async () => {
    const email = `seal.${newId()}@sup.test`;
    await owner.query(
      "INSERT INTO lms.email_suppressions (id, email, reason) VALUES ($1, $2, 'bounce')",
      [newId(), email],
    );
    expect(await seal(email.toUpperCase(), hmac('s'.repeat(40), email), 'k2', false)).toBe(1);
    const [r] = await row(email);
    expect(r).toMatchObject({
      email,
      h: hmac('s'.repeat(40), email).toString('hex'),
      email_hash_kid: 'k2',
    });
    expect(
      (await owner.query('SELECT lms.email_suppressed($1, $2) AS s', [email, 'learning_grades']))
        .rows[0].s,
    ).toBe(true);
  });

  it('drops the plain address (account level): only the hash remains, and the placeholder matches no address', async () => {
    const email = `drop.${newId()}@sup.test`;
    await owner.query(
      "INSERT INTO lms.email_suppressions (id, email, reason) VALUES ($1, $2, 'complaint')",
      [newId(), email],
    );
    const h = hmac('s'.repeat(40), email);
    expect(await seal(email, h, 'k1', true)).toBe(1);
    const [r] = await row(email);
    expect(r.email).toBe(`#${h.toString('hex')}`);
    expect(r.h).toBe(h.toString('hex'));
    expect(await row(email)).toHaveLength(1);
    expect(
      (await owner.query('SELECT lms.email_suppressed($1, $2) AS s', [email, 'learning_grades']))
        .rows[0].s,
    ).toBe(false);
    expect(
      JSON.stringify(
        (await owner.query('SELECT * FROM lms.email_suppressions WHERE id IS NOT NULL')).rows.map(
          (x) => x.email,
        ),
      ),
    ).not.toContain(email);
  });

  it('refuses a missing or short hash, is not callable by lms_app, and lists the key ids in use (rotation)', async () => {
    await expect(
      owner.query("SELECT lms.privacy_suppression_seal('a@b.test', NULL, 'k1', false)"),
    ).rejects.toThrow(/keyed hash/);
    await expect(
      owner.query(
        "SELECT lms.privacy_suppression_seal('a@b.test', decode('abcd', 'hex'), 'k1', false)",
      ),
    ).rejects.toThrow(/keyed hash/);
    await expectPgError(
      app.query(
        "SELECT lms.privacy_suppression_seal('a@b.test', decode(repeat('ab', 32), 'hex'), 'k1', false)",
      ),
      SQLSTATE.insufficientPrivilege,
    );
    const usage = (
      await owner.query('SELECT r_kid, r_rows FROM lms.privacy_suppression_key_usage()')
    ).rows;
    expect(usage.map((u) => u.r_kid)).toEqual(expect.arrayContaining(['k1', 'k2']));
    // lms_app may ask which keys are in use (the operator's check before a key is removed), and sees nothing else
    const asApp = (await app.query('SELECT r_kid FROM lms.privacy_suppression_key_usage()')).rows;
    expect(Object.keys(asApp[0] ?? {})).toEqual(['r_kid']);
  });
});
