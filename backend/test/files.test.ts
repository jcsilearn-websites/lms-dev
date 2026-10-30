import { existsSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvError, parseApiEnv } from '../src/config/env';
import { createLocalStorage } from '../src/core/storage';
import { makeApp, type TestApp } from './app';
import type { TestClient } from './client';
import {
  doc,
  errorCode,
  type Json,
  loginAs,
  newCourse,
  newOffering,
  ok,
  PDF,
  type Person,
  PNG,
  person,
  structure,
  uploadFile,
} from './courses-helpers';
import { type AuthFixture, createAuthFixture, getTestDatabases, testOwnerPool } from './support';

// File storage: the signed-URL protocol (tampering, expiry, size, type, cross-college), serving rules,
// and the purge of unreferenced files.

const SECRET = 'test-only-signing-secret-0123456789abcdef';
const MAX = 4096;

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let adminB: TestClient;
let termId: string;

interface Setup {
  offeringId: string;
  instructor: Person;
  learner: Person;
  moduleId: string;
}

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { STORAGE_MAX_FILE_BYTES: String(MAX), FILE_PURGE_GRACE_HOURS: '24' } });
  A = await createAuthFixture(owner, 'fl-a');
  B = await createAuthFixture(owner, 'fl-b');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  adminB = await loginAs(t, B.host, B.adminEmail);
  termId = (await structure(admin)).termId;
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

async function setup(): Promise<Setup> {
  const c = await newCourse(admin);
  const o = await newOffering(admin, c.id, termId);
  const instructor = await person(owner, t, A, 'Instructor');
  const learner = await person(owner, t, A, 'Learner');
  ok(
    await admin.post(`/offerings/${o.id}/participants`, {
      userId: instructor.userId,
      participation: 'instructor',
    }),
  );
  ok(
    await admin.post(`/offerings/${o.id}/participants`, {
      userId: learner.userId,
      participation: 'learner',
    }),
  );
  ok(await instructor.client.post(`/offerings/${o.id}/publish`));
  const m = ok(await instructor.client.post(`/offerings/${o.id}/modules`, { title: 'M' }));
  ok(await instructor.client.patch(`/offerings/${o.id}/modules/${m.id}`, { published: true }));
  return { offeringId: o.id, instructor, learner, moduleId: m.id };
}

/** Requests an upload and returns it (nothing is sent yet). */
async function requestUpload(s: Setup, name: string, size: number) {
  const r = await s.instructor.client.post(`/offerings/${s.offeringId}/files`, { name, size });
  return r;
}

const put = (
  c: TestClient,
  url: string,
  body: Buffer,
  type: string,
  headers: Record<string, string> = {},
) =>
  c.request('PUT', url, {
    body,
    headers: { 'content-type': type, 'content-length': String(body.length), ...headers },
  });

describe('requesting and confirming an upload', () => {
  it('walks the whole protocol: request, PUT, confirm, attach, download', async () => {
    const s = await setup();
    const file = await uploadFile(s.instructor.client, s.offeringId, 'Syllabus.pdf', PDF);
    expect(file).toMatchObject({
      name: 'Syllabus.pdf',
      contentType: 'application/pdf',
      size: PDF.length,
      status: 'ready',
    });
    const item = ok(
      await s.instructor.client.post(`/offerings/${s.offeringId}/modules/${s.moduleId}/items`, {
        kind: 'file',
        title: 'Syllabus',
        fileId: file.id,
        published: true,
      }),
    );
    expect(item.file).toMatchObject({ id: file.id, name: 'Syllabus.pdf' });

    // the learner gets a signed URL and downloads through it
    const link = ok(
      await s.learner.client.get(`/offerings/${s.offeringId}/items/${item.id}/download`),
    );
    expect(link.inline).toBe(true);
    expect(link.url).toMatch(/^\/api\/storage\/download\//);
    const res = await s.learner.client.get(link.url);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PDF)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="Syllabus.pdf"/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(String(res.headers['cache-control'])).toContain('no-store');
  });

  it('serves anything but PDF / PNG / JPEG as an attachment, whatever the name says', async () => {
    const s = await setup();
    const csv = await uploadFile(
      s.instructor.client,
      s.offeringId,
      'a "quoted"; name é.csv',
      Buffer.from('a,b\n1,2\n'),
    );
    const item = ok(
      await s.instructor.client.post(`/offerings/${s.offeringId}/modules/${s.moduleId}/items`, {
        kind: 'file',
        title: 'Data',
        fileId: csv.id,
        published: true,
      }),
    );
    const link = ok(
      await s.instructor.client.get(`/offerings/${s.offeringId}/items/${item.id}/download`),
    );
    expect(link.inline).toBe(false);
    const res = await s.instructor.client.get(link.url);
    expect(res.headers['content-type']).toBe('text/csv');
    const cd = String(res.headers['content-disposition']);
    expect(cd).toMatch(
      /^attachment; filename="a _quoted__ name _\.csv"; filename\*=UTF-8''a%20%22quoted%22%3B%20name%20%C3%A9\.csv$/,
    );
  });

  it('refuses types that are not allowed, before any upload', async () => {
    const s = await setup();
    for (const name of [
      'evil.exe',
      'page.html',
      'icon.svg',
      'script.js',
      'noextension',
      'x.pdf.exe',
    ]) {
      const r = await requestUpload(s, name, 100);
      expect(r.statusCode, name).toBe(400);
      expect(errorCode(r)).toBe('file_type_not_allowed');
    }
  });

  it('refuses a file over the size limit when asked for, when sent, and when the bytes differ from the announcement', async () => {
    const s = await setup();
    const big = await requestUpload(s, 'big.pdf', MAX + 1);
    expect(big.statusCode).toBe(413);
    expect(errorCode(big)).toBe('file_too_large');

    // announced small, but a LARGER body is sent: the signed limit refuses it with 413 before reading it
    const req = ok(await requestUpload(s, 'sneaky.pdf', 100));
    const body = Buffer.concat([PDF, Buffer.alloc(MAX + 10, 0x41)]);
    const res = await put(s.instructor.client, req.upload.url, body, 'application/pdf');
    expect(res.statusCode).toBe(413);

    // announced 100 bytes, sends 120 (within the limit): confirm notices and removes the object
    const req2 = ok(await requestUpload(s, 'liar.pdf', 100));
    const body2 = Buffer.concat([PDF, Buffer.alloc(120 - PDF.length, 0x41)]);
    expect(
      (await put(s.instructor.client, req2.upload.url, body2, 'application/pdf')).statusCode,
    ).toBe(204);
    const conf = await s.instructor.client.post(`/files/${req2.file.id}/confirm`);
    expect(conf.statusCode).toBe(400);
    expect(errorCode(conf)).toBe('size_mismatch');
    const key = (
      await owner.query('SELECT storage_key FROM lms.files WHERE id = $1', [req2.file.id])
    ).rows[0].storage_key;
    expect(existsSync(path.resolve(process.env.TEST_STORAGE_DIR ?? '.storage-test', key))).toBe(
      false,
    );
  });

  it('checks the content, not the name: a PNG called .pdf, or a script called .pdf, is refused and removed', async () => {
    const s = await setup();
    for (const [name, bytes] of [
      ['fake.pdf', PNG],
      ['script.pdf', Buffer.from('<script>alert(1)</script>')],
      ['image.png', PDF],
    ] as const) {
      const req = ok(await requestUpload(s, name, bytes.length));
      expect(
        (
          await put(
            s.instructor.client,
            req.upload.url,
            Buffer.from(bytes),
            req.upload.headers['content-type'],
          )
        ).statusCode,
      ).toBe(204);
      const conf = await s.instructor.client.post(`/files/${req.file.id}/confirm`);
      expect(conf.statusCode, name).toBe(400);
      expect(errorCode(conf)).toBe('file_content_mismatch');
    }
  });

  it('confirm without an upload is a conflict; only the uploader can confirm; confirming twice is harmless', async () => {
    const s = await setup();
    const req = ok(await requestUpload(s, 'a.pdf', PDF.length));
    const early = await s.instructor.client.post(`/files/${req.file.id}/confirm`);
    expect(early.statusCode).toBe(409);
    expect(errorCode(early)).toBe('upload_missing');
    expect(
      (await put(s.instructor.client, req.upload.url, PDF, 'application/pdf')).statusCode,
    ).toBe(204);
    expect((await s.learner.client.post(`/files/${req.file.id}/confirm`)).statusCode).toBe(404);
    expect((await adminB.post(`/files/${req.file.id}/confirm`)).statusCode).toBe(404);
    expect(ok(await s.instructor.client.post(`/files/${req.file.id}/confirm`)).status).toBe(
      'ready',
    );
    expect(ok(await s.instructor.client.post(`/files/${req.file.id}/confirm`)).status).toBe(
      'ready',
    );
  });

  it('only an editor of the offering can ask for an upload; a file cannot be attached before it is ready or by someone else', async () => {
    const s = await setup();
    expect(
      (await s.learner.client.post(`/offerings/${s.offeringId}/files`, { name: 'a.pdf', size: 10 }))
        .statusCode,
    ).toBe(403);
    expect(
      (await admin.post(`/offerings/${s.offeringId}/files`, { name: 'a.pdf', size: 10 }))
        .statusCode,
    ).toBe(403);
    const pending = ok(await requestUpload(s, 'a.pdf', 50));
    const attach = (fileId: string, who = s.instructor.client) =>
      who.post(`/offerings/${s.offeringId}/modules/${s.moduleId}/items`, {
        kind: 'file',
        title: 'x',
        fileId,
      });
    expect(errorCode(await attach(pending.file.id))).toBe('invalid_file'); // not ready
    // somebody else's ready file
    const s2 = await setup();
    const theirs = await uploadFile(s2.instructor.client, s2.offeringId, 'theirs.pdf', PDF);
    expect(errorCode(await attach(theirs.id))).toBe('invalid_file');
  });
});

describe('signed URLs', () => {
  it('a tampered, expired, mis-used or cross-college token is refused', async () => {
    const s = await setup();
    const req = ok(await requestUpload(s, 'a.pdf', PDF.length));
    const c = s.instructor.client;
    const token = req.upload.url.split('/').pop() as string;
    const [payload, mac] = token.split('.') as [string, string];
    const base = '/api/storage/upload/';
    const attempt = (tok: string, who = c) => put(who, base + tok, PDF, 'application/pdf');

    // a flipped signature, a changed payload, no signature, junk
    expect((await attempt(`${payload}.${mac.slice(0, -2)}AA`)).statusCode).toBe(403);
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        m: 10_000_000,
      }),
    ).toString('base64url');
    expect((await attempt(`${forged}.${mac}`)).statusCode).toBe(403);
    expect((await attempt(payload)).statusCode).toBe(403);
    expect((await attempt('not-a-token-at-all')).statusCode).toBe(403);

    // signed with the right key but already expired
    const past = createLocalStorage({
      dir: '.storage-test',
      secret: SECRET,
      ttlSeconds: 300,
      now: () => Date.now() - 3_600_000,
    });
    const key = (
      await owner.query('SELECT storage_key FROM lms.files WHERE id = $1', [req.file.id])
    ).rows[0].storage_key;
    const old = past.createUploadTarget({ key, contentType: 'application/pdf', maxBytes: MAX });
    expect((await put(c, old.url, PDF, 'application/pdf')).statusCode).toBe(403);

    // a download token cannot upload and an upload token cannot download
    const dl = past.createDownloadTarget({
      key,
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      inline: true,
    });
    const fresh = createLocalStorage({ dir: '.storage-test', secret: SECRET, ttlSeconds: 300 });
    const dlNow = fresh.createDownloadTarget({
      key,
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      inline: true,
    });
    expect((await attempt(dlNow.url.split('/').pop() as string)).statusCode).toBe(403);
    expect((await c.get(req.upload.url.replace('/upload/', '/download/'))).statusCode).toBe(403);
    expect((await c.get(dl.url)).statusCode).toBe(403); // expired

    // a URL of college A does not work on college B's host, in either direction
    const onB = await put(adminB, req.upload.url, PDF, 'application/pdf');
    expect(onB.statusCode).toBe(403);

    // the type declared at upload must be the signed one
    expect((await put(c, req.upload.url, PDF, 'text/html')).statusCode).toBe(400);
    // and the genuine request still works after all of that
    expect((await put(c, req.upload.url, PDF, 'application/pdf')).statusCode).toBe(204);
  });

  it('a download link of an item the learner may not open is never issued', async () => {
    const s = await setup();
    const file = await uploadFile(s.instructor.client, s.offeringId, 'a.pdf', PDF);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const mk = async (extra: Json) =>
      ok(
        await s.instructor.client.post(`/offerings/${s.offeringId}/modules/${s.moduleId}/items`, {
          kind: 'file',
          title: 'f',
          fileId: file.id,
          ...extra,
        }),
      );
    const draft = await mk({});
    const locked = await mk({ published: true, availableFrom: future });
    const open = await mk({ published: true });
    const dl = (id: string) =>
      s.learner.client.get(`/offerings/${s.offeringId}/items/${id}/download`);
    expect((await dl(draft.id)).statusCode).toBe(404);
    expect((await dl(locked.id)).statusCode).toBe(404);
    expect((await dl(open.id)).statusCode).toBe(200);
    // the outsider and another college's admin get nothing at all
    const outsider = await person(owner, t, A, 'Out');
    expect(
      (await outsider.client.get(`/offerings/${s.offeringId}/items/${open.id}/download`))
        .statusCode,
    ).toBe(404);
    expect(
      (await adminB.get(`/offerings/${s.offeringId}/items/${open.id}/download`)).statusCode,
    ).toBe(404);
  });

  it('the public storage routes are rate limited', async () => {
    const tt = makeApp({ env: { STORAGE_MAX_FILE_BYTES: String(MAX) } });
    await tt.app.ready();
    try {
      const c = await loginAs(tt, A.host, A.adminEmail);
      const codes: number[] = [];
      for (let n = 0; n < 130; n++)
        codes.push((await c.get(`/api/storage/download/junk-token-${n}`)).statusCode);
      expect(codes.slice(0, 100).every((x) => x === 403)).toBe(true);
      expect(codes).toContain(429);
    } finally {
      await tt.close();
    }
  });
});

describe('purging unreferenced files', () => {
  const fileRow = async (id: string) =>
    (await owner.query('SELECT * FROM lms.files WHERE id = $1', [id])).rows[0] as Json | undefined;
  const age = (id: string, hours: number) =>
    owner.query(
      `UPDATE lms.files SET created_at = now() - make_interval(hours => $2::int),
              confirmed_at = now() - make_interval(hours => $2::int),
              last_unreferenced_at = CASE WHEN last_unreferenced_at IS NULL THEN NULL
                                          ELSE now() - make_interval(hours => $2::int) END
        WHERE id = $1`,
      [id, hours],
    );
  const storageFile = (key: string) =>
    path.resolve(process.env.TEST_STORAGE_DIR ?? '.storage-test', key);

  it('keeps a file that was confirmed but not attached yet, and deletes it once the grace period has passed', async () => {
    const s = await setup();
    const file = await uploadFile(s.instructor.client, s.offeringId, 'later.pdf', PDF);
    const key = (await fileRow(file.id))?.storage_key as string;
    expect(await t.app.modules.files.service.purgeUnreferenced()).toBe(0);
    expect(await fileRow(file.id)).toBeDefined();
    expect(existsSync(storageFile(key))).toBe(true);

    await age(file.id, 25);
    expect(await t.app.modules.files.service.purgeUnreferenced()).toBeGreaterThanOrEqual(1);
    expect(await fileRow(file.id)).toBeUndefined();
    expect(existsSync(storageFile(key))).toBe(false);
  });

  it('never deletes a referenced file, and restarts the grace period when the last reference is removed', async () => {
    const s = await setup();
    const file = await uploadFile(s.instructor.client, s.offeringId, 'kept.pdf', PDF);
    const item = ok(
      await s.instructor.client.post(`/offerings/${s.offeringId}/modules/${s.moduleId}/items`, {
        kind: 'file',
        title: 'kept',
        fileId: file.id,
      }),
    );
    await age(file.id, 100);
    await t.app.modules.files.service.purgeUnreferenced();
    expect(await fileRow(file.id)).toBeDefined(); // referenced: old, but kept

    // the item goes away: the file is unreferenced NOW, so it gets a fresh grace period
    ok(await s.instructor.client.delete(`/offerings/${s.offeringId}/items/${item.id}`));
    expect((await fileRow(file.id))?.last_unreferenced_at).not.toBeNull();
    await t.app.modules.files.service.purgeUnreferenced();
    expect(await fileRow(file.id)).toBeDefined();
    // once that moment is also old, it is purged
    await owner.query(
      "UPDATE lms.files SET last_unreferenced_at = now() - interval '25 hours' WHERE id = $1",
      [file.id],
    );
    await t.app.modules.files.service.purgeUnreferenced();
    expect(await fileRow(file.id)).toBeUndefined();
  });

  it('a file shared by two offerings (a copy) survives the removal from one of them', async () => {
    const a = await setup();
    const b = await setup();
    ok(
      await admin.post(`/offerings/${a.offeringId}/participants`, {
        userId: b.instructor.userId,
        participation: 'instructor',
      }),
    );
    const file = await uploadFile(a.instructor.client, a.offeringId, 'shared.pdf', PDF);
    const item = ok(
      await a.instructor.client.post(`/offerings/${a.offeringId}/modules/${a.moduleId}/items`, {
        kind: 'file',
        title: 's',
        fileId: file.id,
      }),
    );
    ok(
      await b.instructor.client.post(`/offerings/${b.offeringId}/copy`, {
        sourceOfferingId: a.offeringId,
      }),
    );
    ok(await a.instructor.client.delete(`/offerings/${a.offeringId}/items/${item.id}`));
    await age(file.id, 100);
    await owner.query(
      "UPDATE lms.files SET last_unreferenced_at = now() - interval '100 hours' WHERE id = $1",
      [file.id],
    );
    await t.app.modules.files.service.purgeUnreferenced();
    expect(await fileRow(file.id)).toBeDefined(); // still used by the copy
    void doc;
  });
});

describe('configuration', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_APP_URL: getTestDatabases().appUrl,
    DB_SSL: 'verify-full',
    DB_SSL_CA: 'ca.pem',
    APP_BASE_DOMAIN: 'example.org',
    MAILER: 'none',
    COOKIE_SECURE: 'true',
  };

  it('refuses the local storage driver in production, and a local driver without a signing key', () => {
    expect(() =>
      parseApiEnv({ ...base, STORAGE_DRIVER: 'local', STORAGE_SIGNING_SECRET: 'x'.repeat(40) }),
    ).toThrow(EnvError);
    try {
      parseApiEnv({ ...base, STORAGE_DRIVER: 'local', STORAGE_SIGNING_SECRET: 'x'.repeat(40) });
    } catch (err) {
      expect(String((err as EnvError).message)).toContain('STORAGE_DRIVER');
      expect(String((err as EnvError).message)).not.toContain('xxxxxxxx');
    }
    expect(() =>
      parseApiEnv({ ...base, NODE_ENV: 'development', STORAGE_DRIVER: 'local' }),
    ).toThrow(/STORAGE_SIGNING_SECRET/);
    expect(() =>
      parseApiEnv({
        ...base,
        NODE_ENV: 'development',
        DB_SSL: 'off',
        STORAGE_DRIVER: 'local',
        STORAGE_SIGNING_SECRET: 'x'.repeat(40),
      }),
    ).not.toThrow();
    expect(() => parseApiEnv({ ...base, STORAGE_DRIVER: 'gcs' })).toThrow(/STORAGE_GCS_BUCKET/);
  });

  it('the not-yet-built GCS driver answers 503 instead of failing silently', async () => {
    const g = makeApp({ env: { STORAGE_DRIVER: 'gcs', STORAGE_GCS_BUCKET: 'some-bucket' } });
    await g.app.ready();
    try {
      const adm = await loginAs(g, A.host, A.adminEmail);
      const c = await newCourse(adm);
      const o = await newOffering(adm, c.id, termId);
      const inst = await person(owner, g, A, 'GcsInstructor');
      ok(
        await adm.post(`/offerings/${o.id}/participants`, {
          userId: inst.userId,
          participation: 'instructor',
        }),
      );
      const r = await inst.client.post(`/offerings/${o.id}/files`, { name: 'a.pdf', size: 10 });
      expect(r.statusCode).toBe(503);
      expect(errorCode(r)).toBe('storage_unavailable');
    } finally {
      await g.close();
    }
  });
});
