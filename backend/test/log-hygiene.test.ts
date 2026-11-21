import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import {
  addAssignment,
  base,
  exam,
  handIn,
  inHours,
  keyFromDb,
  queue,
} from './assignments-helpers';
import { deliverEmails, lastTokenFor, TestClient } from './client';
import { loginAs, ok, structure } from './courses-helpers';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// Step 14a: LOG HYGIENE. Representative flows run at DEBUG level (the most a deployment would ever log), and every line that was
// written is searched for what must never be in a log: e-mail addresses, passwords, session / invite / reset tokens, marks,
// feedback and what a learner typed. The values are unmistakable sentinels, so a hit is a leak and not a coincidence.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;

const SENTINELS = {
  wrongPassword: 'Wr0ng-Passw0rd-SENTINEL',
  newPassword: 'N3w-Passw0rd-SENTINEL-x',
  invitePassword: 'Inv1te-Passw0rd-SENTINEL',
  feedback: 'FEEDBACK-SENTINEL-needs-more-evidence',
  learnerText: 'LEARNER-TEXT-SENTINEL-my-private-essay',
  mark: '73.4129',
  displayName: 'Sentinel Displayname Qx',
};

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ logLevel: 'debug', env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'log-a');
  await t.app.ready();
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('logs never contain personal data, credentials or academic content', () => {
  it('after login, failed login, reset, invite, hand-in, grading and mail delivery', async () => {
    const secrets: string[] = Object.values(SENTINELS);
    const emails = new Set<string>([A.adminEmail, A.memberEmail]);

    // --- sign in, fail to sign in
    const member = new TestClient(t, A.host);
    expect((await member.login(A.memberEmail, SENTINELS.wrongPassword)).statusCode).toBe(401);
    expect((await member.login(A.memberEmail, TEST_PASSWORD)).statusCode).toBe(200);
    for (const v of member.cookies.values()) secrets.push(v); // the session token itself
    expect(
      (await member.login('nobody-at-all@log-a.test', SENTINELS.wrongPassword)).statusCode,
    ).toBe(401);
    emails.add('nobody-at-all@log-a.test');

    // --- password reset: the token travels by e-mail only
    expect(
      (await new TestClient(t, A.host).post('/auth/password/forgot', { email: A.memberEmail }))
        .statusCode,
    ).toBeLessThan(300);
    const resetToken = await lastTokenFor(t, A.memberEmail);
    secrets.push(resetToken);
    expect(
      (
        await new TestClient(t, A.host).post('/auth/password/reset', {
          token: resetToken,
          newPassword: SENTINELS.newPassword,
        })
      ).statusCode,
    ).toBeLessThan(300);

    // --- invite and accept
    const admin = await loginAs(t, A.host, A.adminEmail);
    for (const v of admin.cookies.values()) secrets.push(v);
    const invitee = 'invited-person@log-a.test';
    emails.add(invitee);
    ok(
      await admin.post('/auth/invites', {
        email: invitee,
        role: 'member',
        displayName: SENTINELS.displayName,
      }),
    );
    const inviteToken = await lastTokenFor(t, invitee);
    secrets.push(inviteToken);
    expect(
      (
        await new TestClient(t, A.host).post('/auth/invites/accept', {
          token: inviteToken,
          password: SENTINELS.invitePassword,
          displayName: SENTINELS.displayName,
        })
      ).statusCode,
    ).toBeLessThan(300);

    // --- an assignment: hand-in text, a mark and feedback
    const st = await structure(admin);
    const e = await exam(owner, t, A, admin, st, 1);
    for (const p of [e.instructor, e.assistant, ...e.learners]) {
      emails.add(p.email);
      for (const v of p.client.cookies.values()) secrets.push(v);
    }
    const item = await addAssignment(e, {
      settings: { dueAt: inHours(24), allowText: true, maxPoints: 100 },
    });
    const learner = e.learners[0];
    if (!learner) throw new Error('no learner');
    const submitted = await handIn(e, learner, item.id, [], { text: SENTINELS.learnerText });
    expect(submitted.statusCode, submitted.body).toBeLessThan(300);
    await queue(e, e.instructor, item.id); // the first open of the grading queue makes the learners' keys
    const { key } = await keyFromDb(owner, item.id, learner);
    const detail = ok(await e.instructor.client.get(`${base(e, item.id)}/grading/learners/${key}`));
    const graded = await e.instructor.client.put(
      `${base(e, item.id)}/grading/learners/${key}/grade`,
      {
        submissionId: detail.submissions[0].id,
        rawScore: Number(SENTINELS.mark),
        feedback: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: SENTINELS.feedback }] }],
        },
      },
    );
    expect(graded.statusCode, graded.body).toBeLessThan(300);
    ok(await e.instructor.client.post(`${base(e, item.id)}/release`, { learnerKeys: [key] }));
    await deliverEmails(t);
    await t.app.modules.background.drain();

    // --- data export (step 14b): the password asked again, the archive built by the worker from the learner's own data
    expect(
      (await learner.client.post('/me/data-exports', { password: SENTINELS.wrongPassword }))
        .statusCode,
    ).toBe(400);
    const asked = await learner.client.post('/me/data-exports', { password: TEST_PASSWORD });
    expect(asked.statusCode, asked.body).toBe(202);
    await t.app.modules.handlers['privacy.export']?.run(
      { exportId: asked.json().export.id },
      {
        jobId: asked.json().export.id,
        queue: 'privacy.export',
        tenantId: A.tenantId,
        attempt: 1,
        maxAttempts: 3,
        signal: new AbortController().signal,
      },
    );
    emails.add(learner.email);

    // --- the search
    const text = JSON.stringify(t.logs);
    expect(t.logs.length).toBeGreaterThan(50); // the flows really were logged
    for (const s of secrets)
      expect(text, `a log line contains ${s.slice(0, 12)}...`).not.toContain(s);
    for (const email of emails)
      expect(text, `a log line contains the address ${email}`).not.toContain(email);
    // no header / cookie / body dump
    expect(text).not.toMatch(
      /"(authorization|cookie|set-cookie|password|newPassword|token)"\s*:\s*"(?!\[?[Rr]edacted|\*{3})/,
    );
    // and the audit of what happened exists in the database, not in the log
    const audit = await owner.query(
      `SELECT count(*)::int AS n FROM lms.audit_log WHERE tenant_id = $1`,
      [A.tenantId],
    );
    expect(audit.rows[0]?.n).toBeGreaterThan(5);
  }, 60_000);
});
