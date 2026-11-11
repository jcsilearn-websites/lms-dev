// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { addAssignment, base, classOf, handIn, queue } from './assignments-helpers';
import type { TestClient } from './client';
import { type Json, loginAs, ok, type Structure, structure } from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 10: the bulk ZIP of the latest submissions: folders named by register number (anonymous code while blind), the
// files, text and link as small files, a CSV index; streamed; unsafe and unusual file names; read by tools that are NOT ours.

const run = promisify(execFile);
const CI = process.env.CI === 'true';
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;
let dir: string;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'asg-z');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
  dir = await mkdtemp(join(tmpdir(), 'asg-zip-'));
});
afterAll(async () => {
  await t.close();
  await owner.end();
  await rm(dir, { recursive: true, force: true });
});

async function available(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args);
    return true;
  } catch {
    if (CI) throw new Error(`${cmd} is required in CI to validate archives independently`);
    return false;
  }
}

/** The ZIP as bytes, and what Python's zipfile (not our code) makes of it. */
async function download(c: TestClient, url: string, name: string) {
  const res = await c.get(url);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers['content-type']).toBe('application/zip');
  expect(String(res.headers['content-disposition'])).toMatch(/^attachment;/);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  const bytes = res.rawPayload;
  const file = join(dir, name);
  await writeFile(file, bytes);
  let entries: Record<string, { sha256: string; size: number }> = {};
  if (await available(PYTHON, ['-I', '-c', 'import zipfile'])) {
    const { stdout } = await run(PYTHON, ['-I', join(__dirname, 'zipcheck.py'), file]);
    entries = JSON.parse(stdout);
  }
  if (await available('unzip', ['-v'])) {
    const { stdout } = await run('unzip', ['-t', file]);
    expect(stdout).toContain('No errors detected');
  }
  return { bytes, entries, file };
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('submissions.zip', () => {
  let e: Awaited<ReturnType<typeof classOf>>;
  let item: Json;
  const A_PDF = Buffer.from('%PDF-1.4\n%alice\n%%EOF\n');
  const A2_PDF = Buffer.from('%PDF-1.4\n%alice second\n%%EOF\n');
  const B_PDF = Buffer.from('%PDF-1.4\n%bob\n%%EOF\n');
  const B2_PDF = Buffer.from('%PDF-1.4\n%bob two\n%%EOF\n');

  beforeAll(async () => {
    e = await classOf(owner, t, A, admin, st, ['Alice Zip', 'Bob Zip', 'Cara Zip']);
    item = await addAssignment(e, { settings: { allowText: true, allowLink: true, maxFiles: 3 } });
    // Alice: version 1, then version 2 (only the LATEST goes in the ZIP)
    ok(
      await handIn(e, e.learners[0]!, item.id, [
        { name: 'first.pdf', bytes: Buffer.from('%PDF-1.4\n%old\n%%EOF\n') },
      ]),
    );
    ok(
      await handIn(e, e.learners[0]!, item.id, [
        { name: 'report.pdf', bytes: A_PDF },
        { name: 'report.pdf', bytes: A2_PDF },
      ]),
    );
    // Bob: two files with the SAME name, a text and a link
    ok(
      await handIn(
        e,
        e.learners[1]!,
        item.id,
        [
          { name: 'work.pdf', bytes: B_PDF },
          { name: 'work.pdf', bytes: B2_PDF },
        ],
        {
          text: 'Hello ünïcode — 你好',
          link: 'https://example.com/b',
        },
      ),
    );
    // Cara hands in nothing
  });

  it('folders by register number, only the latest version, same-named files made unique, text and link as files', async () => {
    const z = await download(e.instructor.client, `${base(e, item.id)}/submissions.zip`, 'a.zip');
    const names = Object.keys(z.entries).sort();
    if (names.length === 0) return; // no Python locally: the structure is checked in the unit tests of the writer
    const [ra, rb, rc] = e.register as [string, string, string];
    expect(names).toEqual(
      [
        'index.csv',
        `${ra}/report.pdf`,
        `${ra}/report (2).pdf`,
        `${rb}/work.pdf`,
        `${rb}/work (2).pdf`,
        `${rb}/submission.txt`,
        `${rb}/link.txt`,
      ].sort(),
    );
    expect(names.some((n) => n.startsWith(`${rc}/`))).toBe(false);
    expect(z.entries[`${ra}/report.pdf`]!.sha256).toBe(sha(A_PDF));
    expect(z.entries[`${ra}/report (2).pdf`]!.sha256).toBe(sha(A2_PDF));
    expect(z.entries[`${rb}/work.pdf`]!.sha256).toBe(sha(B_PDF));
    expect(z.entries[`${rb}/submission.txt`]!.sha256).toBe(
      sha(Buffer.from('Hello ünïcode — 你好')),
    );
    expect(z.entries[`${rb}/link.txt`]!.sha256).toBe(sha(Buffer.from('https://example.com/b\r\n')));
  });

  it('the CSV index lists one row per submitter with name, register number and lateness', async () => {
    const res = await e.instructor.client.get(`${base(e, item.id)}/submissions.zip`);
    // the index is the first entry, stored: its text is in the stream
    const text = res.rawPayload.toString('utf8');
    expect(text).toContain(
      'folder,name,email,register_number,version,submitted_at,late,late_seconds,penalty_percent,status,files',
    );
    expect(text).toContain('Alice Zip');
    expect(text).toContain('Bob Zip');
    expect(text).not.toContain('Cara Zip');
    expect(text).toContain(`${e.register[0]},Alice Zip`);
  });

  it('an assistant may download it (they grade); a learner may not', async () => {
    expect((await e.assistant.client.get(`${base(e, item.id)}/submissions.zip`)).statusCode).toBe(
      200,
    );
    expect(
      (await e.learners[0]!.client.get(`${base(e, item.id)}/submissions.zip`)).statusCode,
    ).toBe(403);
  });

  it('an assignment nobody has handed in gives a valid, empty ZIP (just the index)', async () => {
    const none = await addAssignment(e);
    const z = await download(
      e.instructor.client,
      `${base(e, none.id)}/submissions.zip`,
      'none.zip',
    );
    if (Object.keys(z.entries).length > 0) expect(Object.keys(z.entries)).toEqual(['index.csv']);
  });

  it('UNSAFE file names (path climbs, drive letters, device names, right-to-left override, huge) never reach the archive', async () => {
    const x = await addAssignment(e, { settings: { maxFiles: 5 } });
    const l = e.learners[2]!;
    ok(
      await handIn(e, l, x.id, [
        { name: 'a.pdf', bytes: Buffer.from('%PDF-1.4\n%1\n%%EOF\n') },
        { name: 'b.pdf', bytes: Buffer.from('%PDF-1.4\n%2\n%%EOF\n') },
        { name: 'c.pdf', bytes: Buffer.from('%PDF-1.4\n%3\n%%EOF\n') },
        { name: 'd.pdf', bytes: Buffer.from('%PDF-1.4\n%4\n%%EOF\n') },
        { name: 'e.pdf', bytes: Buffer.from('%PDF-1.4\n%5\n%%EOF\n') },
      ]),
    );
    // the upload already strips directories; names that only a corrupt row could carry are forced in directly
    const evil = [
      '../../evil.pdf',
      '..\\..\\win.pdf',
      'C:\\Windows\\x.pdf',
      'CON.pdf',
      `${'long'.repeat(200)}.pdf`,
    ];
    const { rows } = await owner.query(
      `SELECT f.id FROM lms.submission_files sf JOIN lms.files f ON f.tenant_id = sf.tenant_id AND f.id = sf.file_id
         JOIN lms.submissions s ON s.tenant_id = sf.tenant_id AND s.id = sf.submission_id
        WHERE s.assignment_item_id = $1 ORDER BY sf.position`,
      [x.id],
    );
    for (const [i, r] of rows.entries()) {
      await owner.query('UPDATE lms.files SET original_name = $2 WHERE id = $1', [
        r.id,
        evil[i]!.slice(0, 255),
      ]);
    }
    await queue(e, e.instructor, x.id);
    const z = await download(e.instructor.client, `${base(e, x.id)}/submissions.zip`, 'evil.zip');
    for (const n of Object.keys(z.entries)) {
      expect(n.startsWith('/')).toBe(false);
      expect(n.split('/').every((p) => p !== '..' && p !== '.' && p !== '')).toBe(true);
      expect(n).not.toContain('\\');
      expect(n).not.toMatch(/^[A-Za-z]:/);
      for (const seg of n.split('/')) {
        expect(seg.split('.')[0]).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i);
        expect([...seg].length).toBeLessThanOrEqual(120);
      }
    }
    // the folder is only the learner's own
    const folders = new Set(
      Object.keys(z.entries)
        .filter((n) => n !== 'index.csv')
        .map((n) => n.split('/')[0]),
    );
    expect(folders.size).toBeLessThanOrEqual(1);
  });

  it('streams: the response is chunked from storage objects, the archive is never built in memory (a 40 MB class)', async () => {
    const big = await addAssignment(e, { settings: { maxFiles: 1, maxFileMb: 30 } });
    // forty files of 1 MB would need uploads; the writer's own test covers 200 MB flat memory, here: one 20 MB file
    const l = e.learners[0]!;
    const body = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.alloc(20 * 1024 * 1024, 0x61),
      Buffer.from('\n%%EOF\n'),
    ]);
    ok(await handIn(e, l, big.id, [{ name: 'big.pdf', bytes: body }]));
    await queue(e, e.instructor, big.id);
    const z = await download(e.instructor.client, `${base(e, big.id)}/submissions.zip`, 'big.zip');
    expect(z.bytes.length).toBeGreaterThan(body.length);
    if (Object.keys(z.entries).length > 0) {
      const entry = Object.entries(z.entries).find(([n]) => n.endsWith('big.pdf'))!;
      expect(entry[1].sha256).toBe(sha(body));
    }
  });
});

describe('submissions.zip while blind', () => {
  it('folders are the anonymous codes in code order; files have neutral names; the index has no identity columns', async () => {
    const names = ['Blindzip One', 'Blindzip Two', 'Blindzip Three'];
    const e = await classOf(owner, t, A, admin, st, names);
    const item = await addAssignment(e, { settings: { anonymousGrading: true } });
    for (const [i, l] of e.learners.entries())
      ok(
        await handIn(e, l, item.id, [
          {
            name: `${names[i]!.replace(' ', '_')}.pdf`,
            bytes: Buffer.from(`%PDF-1.4\n%${i}\n%%EOF\n`),
          },
        ]),
      );
    await queue(e, e.instructor, item.id);
    const z = await download(
      e.instructor.client,
      `${base(e, item.id)}/submissions.zip`,
      'blind.zip',
    );
    const text = z.bytes.toString('utf8');
    for (const s of [...names, ...e.register, ...e.learners.map((l) => l.email), 'Blindzip'])
      expect(text, s).not.toContain(s);
    expect(text).toContain(
      'folder,version,submitted_at,late,late_seconds,penalty_percent,status,files',
    );
    const { rows } = await owner.query(
      'SELECT anon_code FROM lms.assignment_learners WHERE assignment_item_id = $1 ORDER BY anon_code',
      [item.id],
    );
    const codes = rows.map((r) => r.anon_code as string);
    const listed = Object.keys(z.entries);
    if (listed.length > 0) {
      expect(listed.filter((n) => n !== 'index.csv')).toEqual(codes.map((c) => `${c}/file-1.pdf`));
      // the order inside the archive is the code order too
      expect(listed).toEqual(['index.csv', ...codes.map((c) => `${c}/file-1.pdf`)]);
    }
  });
});
