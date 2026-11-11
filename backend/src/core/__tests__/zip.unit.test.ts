import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeFileName, uniqueName } from '../filenames';
import { type ZipEntry, zipStream } from '../zip';

const run = promisify(execFile);
const CI = process.env.CI === 'true';
/** `python3` on Linux and macOS, `python` on Windows */
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

const entryOf = (name: string, data: Buffer): ZipEntry => ({
  name,
  size: data.length,
  open: async () => Readable.from([data.subarray(0, 10), data.subarray(10)]),
});
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zip-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Does the tool exist? Locally a missing tool skips the check; in CI it is a failure (the check must really run). */
async function available(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args);
    return true;
  } catch {
    if (CI) throw new Error(`${cmd} is required in CI to validate archives independently`);
    return false;
  }
}

const SAMPLE = [
  entryOf('a.pdf', randomBytes(5000)),
  entryOf('folder/b.txt', Buffer.from('héllo wörld — ünïcode')),
  entryOf('folder/empty.txt', Buffer.alloc(0)),
];

describe('zip writer: our own CRC and structure check', () => {
  it('writes sizes and CRC-32 that match the bytes (data descriptor and central directory)', async () => {
    const data = randomBytes(70_000);
    const out = await collect(zipStream([entryOf('x.bin', data)]));
    // local header: signature, flags with bit 3 (descriptor) and bit 11 (UTF-8), method 0 (stored)
    expect(out.readUInt32LE(0)).toBe(0x04034b50);
    expect(out.readUInt16LE(6)).toBe(0x0808);
    expect(out.readUInt16LE(8)).toBe(0);
    const bodyStart = 30 + 'x.bin'.length;
    expect(out.subarray(bodyStart, bodyStart + data.length).equals(data)).toBe(true);
    const descriptor = bodyStart + data.length;
    expect(out.readUInt32LE(descriptor)).toBe(0x08074b50);
    expect(out.readUInt32LE(descriptor + 4)).toBe(crc32(data));
    expect(out.readUInt32LE(descriptor + 8)).toBe(data.length);
    expect(out.readUInt32LE(descriptor + 12)).toBe(data.length);
    // end of central directory: one entry
    const eocd = out.length - 22;
    expect(out.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(out.readUInt16LE(eocd + 10)).toBe(1);
  });

  it('an empty archive is just the end record', async () => {
    const out = await collect(zipStream([]));
    expect(out.length).toBe(22);
  });

  it('refuses names that could leave the extraction folder', async () => {
    for (const bad of ['../x', 'a/../x', '/abs', 'a\\b', 'C:x', 'a//b', './x', 'a\u0000b', '']) {
      await expect(collect(zipStream([entryOf(bad, Buffer.from('x'))])), bad).rejects.toThrow();
    }
  });

  it('a missing object aborts the archive instead of writing a hole', async () => {
    const missing: ZipEntry = { name: 'gone.pdf', size: 3, open: async () => null };
    await expect(collect(zipStream([missing]))).rejects.toThrow(/missing/);
  });

  it('streams with flat memory: 200 MB through the writer does not buffer the archive', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const big: ZipEntry = {
      name: 'big.bin',
      size: 200 * chunk.length,
      open: async () =>
        Readable.from(
          (function* () {
            for (let i = 0; i < 200; i++) yield chunk;
          })(),
        ),
    };
    const before = process.memoryUsage().rss;
    let total = 0;
    let peak = 0;
    for await (const c of zipStream([big])) {
      total += (c as Buffer).length;
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    expect(total).toBeGreaterThan(200 * chunk.length);
    expect(peak - before).toBeLessThan(120 * 1024 * 1024);
  });
});

describe('zip writer: independent validators', () => {
  for (const forceZip64 of [false, true]) {
    const label = forceZip64 ? 'ZIP64 form' : 'standard form';

    it(`unzip -t accepts the archive (${label})`, async () => {
      if (!(await available('unzip', ['-v']))) return;
      const file = join(dir, `unzip-${forceZip64}.zip`);
      await writeFile(file, await collect(zipStream(SAMPLE, { forceZip64 })));
      const { stdout } = await run('unzip', ['-t', file]);
      expect(stdout).toContain('No errors detected');
    });

    it(`Python zipfile reads every entry with the right CRC and bytes (${label})`, async () => {
      if (!(await available(PYTHON, ['-I', '-c', 'import zipfile']))) return;
      const file = join(dir, `py-${forceZip64}.zip`);
      await writeFile(file, await collect(zipStream(SAMPLE, { forceZip64 })));
      const { stdout } = await run(PYTHON, [
        '-I',
        join(__dirname, '../../../test/zipcheck.py'),
        file,
      ]);
      const got = JSON.parse(stdout) as Record<
        string,
        { sha256: string; size: number; zip64: boolean }
      >;
      expect(Object.keys(got).sort()).toEqual(['a.pdf', 'folder/b.txt', 'folder/empty.txt']);
      const expectedBytes = new Map<string, Buffer>();
      for (const e of SAMPLE) {
        const b = await collect((await e.open()) as Readable);
        expectedBytes.set(e.name, b);
      }
      for (const [name, b] of expectedBytes) {
        expect(got[name]?.sha256, name).toBe(sha(b));
        expect(got[name]?.size, name).toBe(b.length);
      }
      expect(got['a.pdf']?.zip64).toBe(forceZip64);
    });
  }
});

describe('safeFileName', () => {
  const cases: Array<[string, string]> = [
    ['../../x', '_._x'],
    ['..\\x', '_x'],
    ['C:\\x', 'C__x'],
    ['CON.pdf', '_CON.pdf'],
    ['nul', '_nul'],
    ['COM1.tar.gz', '_COM1.tar.gz'],
    ['lpt9.txt', '_lpt9.txt'],
    ['report.pdf', 'report.pdf'],
    ['.hidden', 'hidden'],
    ['  spaced name.pdf  ', 'spaced name.pdf'],
    ['trailing.dots...', 'trailing.dots'],
    ['a<b>c|d?e*f"g.txt', 'a_b_c_d_e_f_g.txt'],
    ['tab\tnew\nline.pdf', 'tabnewline.pdf'],
    ['', 'file'],
    ['....', 'file'],
  ];
  for (const [input, expected] of cases)
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(safeFileName(input)).toBe(expected);
    });

  it('removes the right-to-left override so "report\u202Efdp.exe" cannot pose as a pdf', () => {
    const out = safeFileName('report\u202Efdp.exe');
    expect(out).toBe('reportfdp.exe');
    expect(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/.test(out)).toBe(false);
  });

  it('limits the length, keeps the extension and never cuts a character in half', () => {
    const out = safeFileName(`${'😀'.repeat(300)}.pdf`);
    expect([...out].length).toBeLessThanOrEqual(120);
    expect(out.endsWith('.pdf')).toBe(true);
    expect(out).not.toContain('\ufffd');
    expect(safeFileName(`${'a'.repeat(500)}.${'b'.repeat(100)}`).length).toBeLessThanOrEqual(120);
  });

  it('no result can climb out of a folder, whatever the input', () => {
    const nasty = [
      '../../etc/passwd',
      '..%2f..%2fx',
      '....//....//x',
      '\\\\server\\share\\x',
      '/etc/passwd',
      '.. /x',
    ];
    for (const n of nasty) {
      const out = safeFileName(n);
      expect(out).not.toMatch(/[\\/]/);
      expect(out).not.toContain('..');
      expect(out.startsWith('.')).toBe(false);
    }
  });

  it('uniqueName keeps names unique inside a folder, ignoring case', () => {
    const used = new Set<string>();
    expect(uniqueName(used, 'a.pdf')).toBe('a.pdf');
    expect(uniqueName(used, 'A.PDF')).toBe('A (2).PDF');
    expect(uniqueName(used, 'a.pdf')).toBe('a (3).pdf');
    expect(uniqueName(used, 'noext')).toBe('noext');
    expect(uniqueName(used, 'noext')).toBe('noext (2)');
  });
});
