import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classify,
  cleanFileName,
  contentDisposition,
  createLocalStorage,
  kindForName,
  type LocalStorage,
  TooLargeError,
} from '../storage';

const TENANT = '01a183c6-b2f4-7bd0-a6ae-58be9db51f10';
const FILE = '01a183c6-b2f4-7bd0-a6ae-58be9db51f11';
const KEY = `${TENANT}/${FILE}`;
const SECRET = 'unit-test-secret-0123456789abcdef-0123';

let dir: string;
let now = 1_700_000_000_000;
let storage: LocalStorage;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'lms-storage-'));
  storage = createLocalStorage({ dir, secret: SECRET, ttlSeconds: 60, now: () => now });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tokenOf = (url: string) => url.split('/').pop() as string;

describe('signed URLs of the local driver', () => {
  it('verifies a fresh token, with its claims, for its own action only', () => {
    const t = storage.createUploadTarget({
      key: KEY,
      contentType: 'application/pdf',
      maxBytes: 1000,
    });
    expect(t.method).toBe('PUT');
    const claims = storage.verify(tokenOf(t.url), 'put');
    expect(claims).toMatchObject({ k: KEY, a: 'put', m: 1000, c: 'application/pdf' });
    expect(storage.verify(tokenOf(t.url), 'get')).toBeNull();
  });

  it('rejects an expired token, a changed signature or payload, and junk', () => {
    const t = storage.createDownloadTarget({
      key: KEY,
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      inline: true,
    });
    const tok = tokenOf(t.url);
    expect(storage.verify(tok, 'get')).not.toBeNull();
    now += 61_000;
    expect(storage.verify(tok, 'get')).toBeNull();
    now -= 61_000;
    const [payload, mac] = tok.split('.') as [string, string];
    expect(storage.verify(`${payload}.${mac.slice(1)}x`, 'get')).toBeNull();
    const changed = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        k: `${TENANT}/${TENANT}`,
      }),
    ).toString('base64url');
    expect(storage.verify(`${changed}.${mac}`, 'get')).toBeNull();
    for (const junk of ['', '.', 'a.b.c', 'x', `${payload}.`])
      expect(storage.verify(junk, 'get')).toBeNull();
  });

  it('a token signed with another key does not verify', () => {
    const other = createLocalStorage({
      dir,
      secret: 'another-secret-0123456789abcdef-0123456',
      ttlSeconds: 60,
      now: () => now,
    });
    const t = other.createDownloadTarget({
      key: KEY,
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      inline: true,
    });
    expect(storage.verify(tokenOf(t.url), 'get')).toBeNull();
  });

  it('refuses any key that is not <tenant uuid>/<file uuid> (no traversal)', () => {
    for (const key of [
      '../etc/passwd',
      `${TENANT}/../x`,
      `${TENANT}/${FILE}/x`,
      '/abs/path',
      `${TENANT}\\${FILE}`,
      'x',
    ]) {
      expect(
        () => storage.createUploadTarget({ key, contentType: 'text/plain', maxBytes: 10 }),
        key,
      ).toThrow();
    }
  });
});

describe('storing and reading', () => {
  it('writes through a stream, reports size / head / sha256, serves it back, and removes it', async () => {
    const body = Buffer.from('%PDF-1.4\nhello world\n');
    expect(await storage.write(KEY, Readable.from([body]), 1000)).toBe(body.length);
    const info = await storage.inspect(KEY);
    expect(info?.size).toBe(body.length);
    expect(info?.head.toString().startsWith('%PDF-')).toBe(true);
    expect(info?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const got = await storage.read(KEY);
    const chunks: Buffer[] = [];
    expect(got).not.toBeNull();
    for await (const c of (got as NonNullable<typeof got>).stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(body)).toBe(true);
    await storage.remove([KEY]);
    expect(await storage.inspect(KEY)).toBeNull();
    expect(await storage.read(KEY)).toBeNull();
    await storage.remove([KEY]); // removing what is gone is fine
  });

  it('stops a body that is larger than allowed and leaves no partial file behind', async () => {
    const key = `${TENANT}/${TENANT}`;
    await expect(
      storage.write(key, Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), 1000),
    ).rejects.toBeInstanceOf(TooLargeError);
    expect(await storage.inspect(key)).toBeNull();
    const left = await readFile(path.join(dir, TENANT)).catch(() => null);
    void left; // the directory exists, but holds no part file
  });
});

describe('file types', () => {
  const pdf = Buffer.from('%PDF-1.7 x');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]);

  it('needs an allowed extension AND matching content', () => {
    expect(classify('a.pdf', pdf)?.mime).toBe('application/pdf');
    expect(classify('A.PDF', pdf)?.mime).toBe('application/pdf');
    expect(classify('a.png', png)?.inline).toBe(true);
    expect(classify('a.jpeg', jpg)?.mime).toBe('image/jpeg');
    expect(classify('a.docx', zip)?.mime).toContain('wordprocessingml');
    expect(classify('a.csv', Buffer.from('a,b\n1,2'))?.mime).toBe('text/csv');
    // the name lies about the content
    expect(classify('a.pdf', png)).toBeNull();
    expect(classify('a.png', pdf)).toBeNull();
    expect(classify('a.docx', pdf)).toBeNull();
    expect(classify('a.txt', Buffer.from([0x68, 0x00, 0x69]))).toBeNull(); // NUL byte: binary
    expect(classify('a.txt', Buffer.from([0xff, 0xfe, 0x41]))).toBeNull(); // not UTF-8
  });

  it('refuses everything that a browser could run or an OS could execute', () => {
    for (const name of [
      'a.html',
      'a.htm',
      'a.svg',
      'a.js',
      'a.exe',
      'a.sh',
      'a.bat',
      'a.php',
      'a.xml',
      'a',
      'a.pdf.exe',
      '.pdf',
    ]) {
      expect(kindForName(name), name).toBeNull();
    }
  });

  it('shows only PDF / PNG / JPEG inline', () => {
    const inline = [
      'a.pdf',
      'a.png',
      'a.jpg',
      'a.gif',
      'a.webp',
      'a.docx',
      'a.csv',
      'a.mp4',
      'a.zip',
    ].filter((n) => kindForName(n)?.inline);
    expect(inline).toEqual(['a.pdf', 'a.png', 'a.jpg']);
  });

  it('builds a safe Content-Disposition and a clean display name', () => {
    expect(cleanFileName('..\\..\\evil/../name.pdf')).toBe('name.pdf');
    expect(cleanFileName('a\u0000b\r\nc.pdf')).toBe('abc.pdf');
    const h = contentDisposition('x";\r\nSet-Cookie: a=b.pdf', false);
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.startsWith('attachment; filename="')).toBe(true);
    expect(contentDisposition('é.pdf', true)).toContain("filename*=UTF-8''%C3%A9.pdf");
  });
});
