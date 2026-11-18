import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp, type TestApp } from './app';
import type { TestClient } from './client';
import {
  errorCode,
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
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 14a: STORAGE ERRORS are clean 503s (`storage_unavailable` + Retry-After), never 500s, and the service recovers when the
// storage does. The faults are injected under the real local driver by failing the file-system calls it makes (ENOSPC, EIO).

const faults = vi.hoisted(() => ({ code: null as string | null, calls: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  // biome-ignore lint/suspicious/noExplicitAny: a generic wrapper over several fs signatures
  const guard = <F extends (...a: any[]) => any>(fn: F): F =>
    ((...args: Parameters<F>) => {
      if (faults.code) {
        faults.calls++;
        return Promise.reject(Object.assign(new Error('injected fault'), { code: faults.code }));
      }
      return fn(...args);
    }) as F;
  return { ...real, mkdir: guard(real.mkdir), open: guard(real.open), stat: guard(real.stat) };
});

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let offeringId: string;
let instructor: Person;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ logLevel: 'warn' });
  A = await createAuthFixture(owner, 'res-s');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  const { termId } = await structure(admin);
  const c = await newCourse(admin);
  const o = await newOffering(admin, c.id, termId);
  offeringId = o.id;
  instructor = await person(owner, t, A, 'Instr');
  ok(
    await admin.post(`/offerings/${o.id}/participants`, {
      userId: instructor.userId,
      participation: 'instructor',
    }),
  );
  ok(await instructor.client.post(`/offerings/${o.id}/publish`));
});
afterAll(async () => {
  faults.code = null;
  await t.close();
  await owner.end();
});

describe('storage errors', () => {
  it('a full disk (ENOSPC) on upload is a clean 503 with Retry-After, not a 500; the next upload works', async () => {
    const req = ok(
      await instructor.client.post(`/offerings/${offeringId}/files`, {
        name: 'a.pdf',
        size: PDF.length,
      }),
    );
    faults.code = 'ENOSPC';
    const put = await instructor.client.request('PUT', req.upload.url, {
      body: PDF,
      headers: { ...req.upload.headers, 'content-length': String(PDF.length) },
    });
    faults.code = null;
    expect(put.statusCode, put.body).toBe(503);
    expect(errorCode(put)).toBe('storage_unavailable');
    expect(put.headers['retry-after']).toBeDefined();
    expect(put.json().error.message).not.toMatch(/ENOSPC|injected|\.storage/);

    // the storage is back: the whole protocol works, and the earlier file left no half-confirmed state
    const file = await uploadFile(instructor.client, offeringId, 'b.pdf', PDF);
    expect(file.status).toBe('ready');
  });

  it('an I/O error (EIO) while confirming an upload is a clean 503, and confirming again later works', async () => {
    const req = ok(
      await instructor.client.post(`/offerings/${offeringId}/files`, {
        name: 'c.pdf',
        size: PDF.length,
      }),
    );
    const put = await instructor.client.request('PUT', req.upload.url, {
      body: PDF,
      headers: { ...req.upload.headers, 'content-length': String(PDF.length) },
    });
    expect(put.statusCode).toBe(204);
    faults.code = 'EIO';
    const confirm = await instructor.client.post(`/files/${req.file.id}/confirm`);
    faults.code = null;
    expect(confirm.statusCode, confirm.body).toBe(503);
    expect(errorCode(confirm)).toBe('storage_unavailable');
    const again = ok(await instructor.client.post(`/files/${req.file.id}/confirm`));
    expect(again.status).toBe('ready');
  });

  it('a read error on download is a clean 503; the file downloads once the storage is back', async () => {
    const file = await uploadFile(instructor.client, offeringId, 'd.pdf', PDF);
    const mod = ok(
      await instructor.client.post(`/offerings/${offeringId}/modules`, { title: 'M' }),
    );
    const item = ok(
      await instructor.client.post(`/offerings/${offeringId}/modules/${mod.id}/items`, {
        kind: 'file',
        title: 'D',
        fileId: file.id,
        published: true,
      }),
    );
    const link = ok(
      await instructor.client.get(`/offerings/${offeringId}/items/${item.id}/download`),
    );
    faults.code = 'EIO';
    const bad = await instructor.client.get(link.url);
    faults.code = null;
    expect(bad.statusCode, bad.body).toBe(503);
    expect(errorCode(bad)).toBe('storage_unavailable');
    const good = await instructor.client.get(link.url);
    expect(good.statusCode).toBe(200);
    expect(good.rawPayload.equals(PDF)).toBe(true);
  });

  it('none of it was logged as an unhandled error (an unwell disk is not a bug)', () => {
    expect(t.logs.filter((l) => l.msg === 'unhandled error')).toEqual([]);
  });
});
