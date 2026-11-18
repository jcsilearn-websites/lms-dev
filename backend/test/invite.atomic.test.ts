import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { createDb, type Database } from '../src/db/client';
import { createAuditRepository, createAuditService } from '../src/modules/audit';
import { createMembershipsRepository, createMembershipsService } from '../src/modules/memberships';
import { type AuthFixture, createAuthFixture, testAppDbOptions, testOwnerPool } from './support';

// An invite is ALL of its parts or none of them: the membership, its audit row (`auth.invite_created`) and the email that the audit
// trigger queues. The first Linux CI run of the Postgres-restart test found a pending member WITHOUT an audit row: the membership and
// the audit row were two transactions, and a connection lost between them left half an invite (a member nobody was told about and no
// audit entry of who invited them). This is the deterministic version of that test: the step that follows the membership fails, and
// the membership must not survive.

let owner: pg.Pool;
let A: AuthFixture;
let db: Database;

beforeAll(async () => {
  owner = testOwnerPool();
  A = await createAuthFixture(owner, 'inv-atomic');
  db = createDb(testAppDbOptions(2));
});
afterAll(async () => {
  await db.close();
  await owner.end();
});

async function newUser(email: string): Promise<string> {
  const id = newId();
  await owner.query(`INSERT INTO lms.users (id, email, display_name) VALUES ($1, $2, 'Invitee')`, [
    id,
    email,
  ]);
  return id;
}

const counts = async (userId: string) => {
  const m = await owner.query<{ id: string }>(
    `SELECT id FROM lms.tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
    [A.tenantId, userId],
  );
  const ids = m.rows.map((r) => r.id);
  const audit = await owner.query(
    `SELECT 1 FROM lms.audit_log WHERE tenant_id = $1 AND action = 'auth.invite_created' AND target_id = ANY($2::text[])`,
    [A.tenantId, ids],
  );
  const outbox = await owner.query(
    `SELECT 1 FROM lms.email_outbox WHERE tenant_id = $1 AND template = 'invite' AND params ->> 'membershipId' = ANY($2::text[])`,
    [A.tenantId, ids],
  );
  return { memberships: ids.length, audit: audit.rowCount, outbox: outbox.rowCount };
};

describe('an invite is atomic', () => {
  const memberships = () =>
    createMembershipsService({ db, membershipsRepo: createMembershipsRepository() });
  const audit = () => createAuditService({ db, auditRepo: createAuditRepository() });

  it('when the step after the membership fails, no membership is left behind', async () => {
    const userId = await newUser('half@inv-atomic.test');
    await expect(
      memberships().invite(A.tenantId, { userId, role: 'member' }, async () => {
        throw new Error('the connection died here');
      }),
    ).rejects.toThrow('the connection died here');
    expect(await counts(userId)).toEqual({ memberships: 0, audit: 0, outbox: 0 });
  });

  it('when the audit row is written with the membership, all three exist: membership, audit row, queued email', async () => {
    const userId = await newUser('whole@inv-atomic.test');
    const a = audit();
    const m = await memberships().invite(A.tenantId, { userId, role: 'member' }, (tx, row) =>
      a.recordIn(tx, A.tenantId, {
        actorUserId: A.adminUserId,
        action: 'auth.invite_created',
        targetType: 'membership',
        targetId: row.id,
        metadata: { role: 'member' },
      }),
    );
    expect(m.status).toBe('pending');
    expect(await counts(userId)).toEqual({ memberships: 1, audit: 1, outbox: 1 });
  });

  it('a failing audit row (invalid entry) also leaves no membership', async () => {
    const userId = await newUser('badaudit@inv-atomic.test');
    const a = audit();
    await expect(
      memberships().invite(A.tenantId, { userId, role: 'member' }, (tx, row) =>
        a.recordIn(tx, A.tenantId, {
          actorUserId: A.adminUserId,
          action: '', // refused: an action is 1-100 characters
          targetType: 'membership',
          targetId: row.id,
        }),
      ),
    ).rejects.toBeDefined();
    expect(await counts(userId)).toEqual({ memberships: 0, audit: 0, outbox: 0 });
  });
});
