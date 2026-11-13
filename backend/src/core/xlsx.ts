import { Readable } from 'node:stream';
import { type ZipEntry, zipStream } from './zip';

// A minimal XLSX writer for exports that people upload to university portals. It is safe against formula injection by
// CONSTRUCTION, not by escaping: numbers are written as numeric cells (`<c><v>12.5</v></c>`), text as inline strings
// (`t="inlineStr"`), and the writer has no code path that emits a formula (`<f>`): a text cell that starts with `=` is just
// text in the file (a test reads the generated XML and fails if an `<f` element could appear). CSV exports use the
// apostrophe rule instead (core/csv.ts).

export type XlsxCell = string | number | null | undefined;

// XML 1.0 forbids most control characters, even escaped
// biome-ignore lint/suspicious/noControlCharactersInRegex: exactly the characters XML cannot carry
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const escapeXml = (s: string): string =>
  s
    .replace(XML_FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 0 -> A, 25 -> Z, 26 -> AA */
export function columnName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function sanitizeSheetName(name: string): string {
  const s = name
    .replace(/[[\]:*?/\\]/g, ' ')
    .trim()
    .slice(0, 31);
  return s === '' ? 'Sheet1' : s;
}

function rowXml(cells: readonly XlsxCell[], rowNo: number, bold: boolean): string {
  let out = `<row r="${rowNo}">`;
  cells.forEach((v, i) => {
    if (v === null || v === undefined || v === '') return;
    const ref = `${columnName(i)}${rowNo}`;
    const style = bold ? ' s="1"' : '';
    if (typeof v === 'number') {
      // never a formula, never text: a finite number or nothing
      if (Number.isFinite(v)) out += `<c r="${ref}"${style}><v>${v}</v></c>`;
    } else {
      out += `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
    }
  });
  return `${out}</row>`;
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/**
 * The workbook as a ZIP byte stream. The first row is the header (bold). The sheet is built in memory (an export has at most a
 * few thousand rows), the ZIP around it is streamed.
 */
export async function xlsxStream(
  sheetName: string,
  rows: AsyncIterable<readonly XlsxCell[]> | Iterable<readonly XlsxCell[]>,
): Promise<Readable> {
  const parts: string[] = [];
  let n = 0;
  for await (const r of rows as AsyncIterable<readonly XlsxCell[]>) {
    n++;
    parts.push(rowXml(r, n, n === 1));
  }
  const sheet = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${parts.join('')}</sheetData></worksheet>`;
  const files: Record<string, string> = {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sanitizeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': sheet,
  };
  const modified = new Date();
  const entries: ZipEntry[] = Object.entries(files).map(([name, text]) => {
    const bytes = Buffer.from(text, 'utf8');
    return { name, size: bytes.length, modified, open: async () => Readable.from([bytes]) };
  });
  return zipStream(entries);
}
