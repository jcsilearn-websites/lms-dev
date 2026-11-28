import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testOwnerPool } from './support';

// The database side of test/identity-readers.unit.test.ts: every FUNCTION (and view) whose source reads lms.users is listed with the
// reason it needs the real value. A college-scoped reader of a name or an address uses lms.member_identity (migrations 0060 / 0061).

let owner: pg.Pool;
beforeAll(() => {
  owner = testOwnerPool();
});
afterAll(async () => {
  await owner.end();
});

const LIVE_ADDRESS =
  'mail delivery needs the live address; an erased member is a removed member (security mail and the claim check the status) and the erasure blanks their outbox rows';

const ALLOWED: Record<string, string> = {
  auth_ensure_user: 'creates the global account of a person signing up through an invite',
  auth_find_login: 'sign-in: finds the account by address (the college host is already known)',
  auth_login_begin: 'sign-in: the account and its credentials',
  auth_lookup_session:
    'the session of the signed-in person (they read their OWN account on every request)',
  email_enqueue_security: LIVE_ADDRESS,
  email_suppression_status:
    'the address of the signed-in member, to show them their own suppression banner',
  email_suppression_clear_tenant:
    'matches a suppression to a member of the college by address; refuses a removed member',
  email_suppressions_for_tenant:
    'matches the address of a suppression; the NAME comes from lms.member_identity and an erased member is never listed',
  import_ensure_users: 'creates accounts for the staged rows of one import (no name is read out)',
  membership_set_search_keys:
    'sets the search keys when a membership is INSERTED: an override cannot exist for a row that is being created',
  notify_fanout: LIVE_ADDRESS,
  notify_unsubscribe_info:
    'the masked address of a non-removed member, for the public unsubscribe page',
  privacy_export_collect:
    'the OWN account row of the person asking, in THEIR OWN data export (read for the claimed export of that user only)',
  audit_log_guard:
    "the append-only guard of the audit log: reads the erased member's address only to decide whether a scrub concerns that member",
  privacy_scrub_audit:
    "the one scrub of the audit log: finds the rows that carry the erased member's address (internal, no EXECUTE for lms_app)",
  privacy_erasure_preview:
    "counts only: it matches staged import rows by the member's OWN address, and returns numbers, never a value",
  privacy_erasure_prepare:
    'hands the worker the address of a member whose erasure is DUE (it is hashed with the key the database does not have)',
  privacy_erasure_execute:
    "the erasure itself: checks the address the worker hashed is still the member's, then erases (one transaction)",
  privacy_erasure_reapply_prepare:
    'after a restore: the address of a person the ledger says was erased and is not erased in the restored database',
  privacy_erasure_reapply:
    'after a restore: erases the person from the ledger again (checks the address, then the same core as the execution)',
  notify_usage_closed: 'the address of the platform administrators',
  // two-factor sign-in (step 14c): all about the ONE person signing in, never a list of members
  session_insert:
    'internal (no grant): the account of the person being signed in, for the answer of THEIR own sign-in',
  mfa_required_here:
    'internal: reads only the platform administrator flag of the person signing in',
  mfa_password_accepted:
    'internal: after the right password, reads only the platform administrator flag of that person',
  mfa_enrol_lookup:
    'the OWN address of the person holding the emailed enrolment link (shown in their authenticator app)',
  mfa_recovery_use: 'reads only the platform administrator flag of the person signing in',
  mfa_required_anywhere: 'internal: reads only the platform administrator flag of one person',
  mfa_platform_actor: 'internal: re-checks that the actor is a platform administrator',
  mfa_reset_request:
    'GLOBAL: a platform administrator files the reset of ONE account, found by its address',
  mfa_reset_list:
    'GLOBAL, platform administrators only: shows the account of each reset request (no college member list; a pseudonym once erased)',
  mfa_reset_mail:
    'internal: reads only the platform administrator flag, to choose the host of the security mail',
  mfa_break_glass: 'owner connection only: finds the ONE account of the break glass by its address',
};
// The platform area (admin host). REVIEWED one by one (step 14b-1): none of them lists the members of one college. The only
// college-scoped member list on the admin host, GET /platform/tenants/:id/members, is served by memberships.listPageIn, which reads
// lms.member_identity (so a platform administrator sees the pseudonym of an erased member too; tested in member-identity.test.ts).
const ACTOR_CHECK =
  'only re-checks that the actor is a platform administrator (reads the flag, no name or address)';
const ALLOWED_PREFIX: Record<string, string> = {};
const ACCOUNT_LEVEL =
  'GLOBAL account erasure (step 14b-1 part 4): works on the account row itself, never returns a name or an address to a college';
Object.assign(ALLOWED, {
  guard_erased_user:
    'trigger: locks the account row and refuses a membership, session or token for an erased account',
  privacy_account_erase_core: `${ACCOUNT_LEVEL}; reads the account to pseudonymise it`,
  privacy_account_execute: `${ACCOUNT_LEVEL}; checks the address the worker hashed is still the account's`,
  privacy_account_lock: `${ACCOUNT_LEVEL}; takes the row locks in the fixed order`,
  privacy_account_mine: `${ACCOUNT_LEVEL}; the caller's OWN eligibility (platform admin flag)`,
  privacy_account_platform_decide: `${ACCOUNT_LEVEL}; the actor must be a platform administrator`,
  privacy_account_platform_list: `${ACCOUNT_LEVEL}; the actor must be a platform administrator (shows the pseudonym once erased)`,
  privacy_account_platform_request: `${ACCOUNT_LEVEL}; the actor must be a platform administrator, finds the account by address`,
  privacy_account_prepare: `${ACCOUNT_LEVEL}; the address the worker hashes, only for a request that is due`,
  privacy_account_reapply: `${ACCOUNT_LEVEL}; after a restore: erased again from the ledger`,
  privacy_account_reapply_prepare: `${ACCOUNT_LEVEL}; the address the CLI hashes`,
  privacy_account_request_combined: `${ACCOUNT_LEVEL}; the caller's own platform-admin flag`,
});
Object.assign(ALLOWED, {
  platform_admin_invite:
    'GLOBAL: invites or promotes a person by address (creates or finds the account); a member list is not returned',
  platform_create_tenant: ACTOR_CHECK,
  platform_get_tenant: ACTOR_CHECK,
  platform_list_tenants: `${ACTOR_CHECK}; lists colleges, not people`,
  platform_set_tenant_status: ACTOR_CHECK,
  platform_update_tenant: ACTOR_CHECK,
  platform_set_email_sender: ACTOR_CHECK,
  platform_usage: `${ACTOR_CHECK}; aggregates only`,
  platform_notifications_page: ACTOR_CHECK,
  platform_notifications_read: ACTOR_CHECK,
  platform_notifications_unread: ACTOR_CHECK,
  platform_email_suppressions:
    'GLOBAL: lists suppressed ADDRESSES (global by address) with the college slug, never a member name',
  platform_email_suppression_clear: 'GLOBAL: clears a suppression by id; no name returned',
  platform_list_audit: `${ACTOR_CHECK}; the platform log is written by platform administrators`,
  platform_list_audit_v2:
    'GLOBAL: names the ACTORS of the platform audit log, who are platform administrators (not members of a college)',
});

describe('database functions that read lms.users directly', () => {
  it('are exactly the listed ones, each with its reason', async () => {
    const { rows } = await owner.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lms'
          AND p.prosrc ~* '(lms\\.users|\\mfrom\\s+users\\M|\\mjoin\\s+users\\M)'
        ORDER BY 1`,
    );
    const names = rows.map((r) => r.proname);
    const unlisted = names.filter(
      (n) => !(n in ALLOWED) && !Object.keys(ALLOWED_PREFIX).some((p) => n.startsWith(p)),
    );
    expect(
      unlisted,
      'a function reads lms.users: a college-scoped reader must use lms.member_identity; otherwise list it here with the reason',
    ).toEqual([]);
    // a listed function that no longer reads the table is a stale entry
    const stale = Object.keys(ALLOWED).filter((n) => !names.includes(n));
    expect(stale, 'delete these entries').toEqual([]);
    for (const reason of [...Object.values(ALLOWED), ...Object.values(ALLOWED_PREFIX)])
      expect(reason.length).toBeGreaterThan(30);
  });

  it('the functions moved to the identity view read it (and the gradebook ones no longer read the table)', async () => {
    const moved = [
      'gradebook_config',
      'gradebook_explain',
      'gradebook_excluded',
      'gradebook_queue',
      'gradebook_snapshot_meta',
      'gradebook_grid',
      'gradebook_review_action',
      'email_suppressions_for_tenant',
    ];
    const { rows } = await owner.query<{ proname: string; ident: boolean; users: boolean }>(
      `SELECT p.proname, p.prosrc ~* 'lms\\.member_identity' AS ident, p.prosrc ~* 'lms\\.users' AS users
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lms' AND p.proname = ANY($1)`,
      [moved],
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([...moved].sort());
    for (const r of rows) {
      expect(r.ident, r.proname).toBe(true);
      if (r.proname !== 'email_suppressions_for_tenant') expect(r.users, r.proname).toBe(false);
    }
  });

  it('the only view over the user table is the identity view', async () => {
    const { rows } = await owner.query<{ viewname: string; definition: string }>(
      "SELECT viewname, definition FROM pg_views WHERE schemaname = 'lms'",
    );
    expect(rows.map((r) => r.viewname)).toEqual(['member_identity']);
    const opts = await owner.query(
      "SELECT reloptions FROM pg_class WHERE oid = 'lms.member_identity'::regclass",
    );
    expect(opts.rows[0].reloptions).toContain('security_invoker=true');
  });
});
