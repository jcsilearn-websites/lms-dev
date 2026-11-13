import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { columnName, sanitizeSheetName, type XlsxCell, xlsxStream } from '../xlsx';

const run = promisify(execFile);
const CI = process.env.CI === 'true';
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

/** Reads the STORE-only entries of our own archive through the central directory. */
function entries(buf: Buffer): Record<string, string> {
  let eocd = buf.length - 22;
  while (eocd > 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out[name] = buf.toString('utf8', start, start + size);
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

const build = async (rows: XlsxCell[][]) => collect(await xlsxStream('Gradebook', rows));

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xlsx-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('xlsx writer', () => {
  it('column letters', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
    ]);
  });

  it('numbers are numeric cells, text is an inline string, empty cells are left out', async () => {
    const files = entries(
      await build([
        ['Name', 'Mark'],
        ['Asha', 45],
        ['Bala', 12.5],
        ['Chitra', null],
      ]),
    );
    const sheet = files['xl/worksheets/sheet1.xml'] as string;
    expect(sheet).toContain(
      '<c r="A2" t="inlineStr"><is><t xml:space="preserve">Asha</t></is></c>',
    );
    expect(sheet).toContain('<c r="B2"><v>45</v></c>');
    expect(sheet).toContain('<c r="B3"><v>12.5</v></c>');
    expect(sheet).not.toContain('r="B4"');
    // the header is bold (style 1)
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">');
  });

  it('can NOT emit a formula: text that starts with = + - @ stays text, and no <f> element exists in any part', async () => {
    const evil = [
      '=1+1',
      '+1+1',
      '-1+1',
      '@SUM(A1)',
      '=HYPERLINK("http://evil.example")',
      '\t=1',
      "=cmd|' /C calc'!A0",
    ];
    const files = entries(await build([evil, evil.map((_, i) => i)]));
    for (const [name, xml] of Object.entries(files)) expect(xml, name).not.toMatch(/<f[\s>/]/);
    const sheet = files['xl/worksheets/sheet1.xml'] as string;
    expect(sheet.match(/t="inlineStr"/g)).toHaveLength(evil.length);
    expect(sheet).toContain('>=1+1<');
    expect(sheet).toContain('HYPERLINK(&quot;http://evil.example&quot;)');
  });

  it('a number that is not finite is dropped, never written as text or a formula', async () => {
    const sheet = entries(await build([[Number.NaN, Number.POSITIVE_INFINITY, 1]]))[
      'xl/worksheets/sheet1.xml'
    ] as string;
    expect(sheet).toContain('<c r="C1" s="1"><v>1</v></c>');
    expect(sheet).not.toContain('NaN');
    expect(sheet).not.toContain('Infinity');
  });

  it('escapes markup and removes characters XML cannot carry; the sheet name is made safe', async () => {
    const sheet = entries(await build([['<b>&"x"\u0000\u0007</b>']]))[
      'xl/worksheets/sheet1.xml'
    ] as string;
    expect(sheet).toContain('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point of the check is that no control character survives
    expect(sheet).not.toMatch(/[\u0000-\u0008]/);
    expect(sanitizeSheetName('A/B[C]:D*E?F\\G very long name that goes on and on')).toHaveLength(
      31,
    );
    expect(sanitizeSheetName('   ')).toBe('Sheet1');
  });

  it('is a valid archive for Python (independent reader)', async () => {
    const file = join(dir, 'x.xlsx');
    await writeFile(file, await build([['a', 1]]));
    try {
      await run(PYTHON, [
        '-I',
        '-c',
        'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.namelist()))',
        file,
      ]);
    } catch (err) {
      if (CI) throw err;
    }
  });
});

describe('xlsx opens in LibreOffice (headless) with numbers as numbers', () => {
  // The independent reader of the real world: LibreOffice converts the workbook to CSV, and a formula in a cell would show up as
  // its RESULT. CI installs libreoffice-calc; locally a missing install skips the check.
  async function soffice(): Promise<string | null> {
    for (const cmd of ['soffice', 'libreoffice']) {
      try {
        await run(cmd, ['--version']);
        return cmd;
      } catch {
        /* try the next one */
      }
    }
    if (CI)
      throw new Error(
        'libreoffice is required in CI to check that the generated XLSX opens correctly',
      );
    return null;
  }

  it('numbers stay numbers, formula-looking text stays text', async () => {
    const cmd = await soffice();
    if (!cmd) return;
    const file = join(dir, 'lo.xlsx');
    await writeFile(
      file,
      await build([
        ['Register', 'Name', 'Mark', 'Final'],
        ['R1', 'Asha', 45, 35.5],
        ['R2', '=1+1', 12, 0],
        ['R3', '@SUM(A1)', 7.25, 100],
      ]),
    );
    await run(
      cmd,
      [
        '--headless',
        '--norestore',
        `-env:UserInstallation=file:///${dir.replace(/\\/g, '/')}/profile`,
        '--convert-to',
        'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false',
        '--outdir',
        dir,
        file,
      ],
      { timeout: 120_000 },
    );
    const csv = (await readFile(join(dir, 'lo.csv'), 'utf8')).trim().split(/\r?\n/);
    expect(csv[0]).toBe('Register,Name,Mark,Final');
    expect(csv[1]).toBe('R1,Asha,45,35.5');
    expect(csv[2]).toBe('R2,=1+1,12,0'); // text, not 2
    expect(csv[3]).toBe('R3,@SUM(A1),7.25,100');
  }, 150_000);
});
