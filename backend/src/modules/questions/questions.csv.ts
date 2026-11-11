import type { QuestionInput } from '../../contracts';
import { csvLine } from '../../core/csv';
import { checkCell } from '../imports';
import { InvalidQuestionError } from './questions.errors';
import { type BuiltVersion, buildVersion } from './questions.keys';

// The CSV template and the row parser of the question import. Choice questions only (single, multiple, true / false):
// they are what a spreadsheet can carry. Every cell goes through the same formula-injection check as the member import
// (a leading = @ tab or CR, and + / - in a text column, is refused), and nothing is HTML: text becomes plain rich text.

export const OPTION_COLUMNS = [
  'option_a',
  'option_b',
  'option_c',
  'option_d',
  'option_e',
  'option_f',
] as const;
export const COLUMNS = [
  'type',
  'question',
  ...OPTION_COLUMNS,
  'correct',
  'difficulty',
  'tags',
  'partial_credit',
  'explanation',
] as const;
export type Column = (typeof COLUMNS)[number];
const REQUIRED: Column[] = ['type', 'question', 'correct'];

export function templateCsv(): string {
  return [
    csvLine([...COLUMNS]),
    csvLine([
      'single_choice',
      'Which planet is closest to the Sun?',
      'Venus',
      'Mercury',
      'Earth',
      'Mars',
      '',
      '',
      'B',
      'easy',
      'astronomy;planets',
      '',
      'Mercury orbits closest to the Sun.',
    ]),
    csvLine([
      'multiple_choice',
      'Which of these are prime numbers?',
      '2',
      '4',
      '7',
      '9',
      '',
      '',
      'A;C',
      'medium',
      'maths',
      'yes',
      '',
    ]),
    csvLine([
      'true_false',
      'The Earth orbits the Sun.',
      '',
      '',
      '',
      '',
      '',
      '',
      'true',
      'easy',
      'astronomy',
      '',
      '',
    ]),
  ].join('');
}

export type HeaderResult =
  | { ok: true; index: Map<Column, number> }
  | { ok: false; message: string };

export function mapHeader(header: readonly string[]): HeaderResult {
  const index = new Map<Column, number>();
  const unknown: string[] = [];
  header.forEach((h, i) => {
    const name = h
      .replace(/^\uFEFF/, '')
      .trim()
      .toLowerCase();
    if ((COLUMNS as readonly string[]).includes(name)) {
      if (index.has(name as Column)) unknown.push(`${name} (twice)`);
      else index.set(name as Column, i);
    } else if (name !== '') unknown.push(h.trim().slice(0, 40));
  });
  const missing = REQUIRED.filter((c) => !index.has(c));
  if (missing.length > 0)
    return {
      ok: false,
      message: `The file has no ${missing.join(', ')} column: download the template`,
    };
  if (unknown.length > 0)
    return {
      ok: false,
      message: `Unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.slice(0, 5).join(', ')}`,
    };
  return { ok: true, index };
}

export interface RowError {
  column: string;
  message: string;
}
export interface ParsedQuestionRow {
  raw: Record<string, string>;
  errors: RowError[];
  parsed: {
    type: BuiltVersion['type'];
    difficulty: string;
    tags: string[];
    presentation: unknown;
    answerKey: unknown;
  } | null;
}

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const YES = new Set(['yes', 'y', 'true', '1']);

export function parseRow(index: Map<Column, number>, record: readonly string[]): ParsedQuestionRow {
  const cell = (c: Column): string => (record[index.get(c) ?? -1] ?? '').trim();
  const raw: Record<string, string> = {};
  const errors: RowError[] = [];
  for (const c of COLUMNS) {
    if (!index.has(c)) continue;
    raw[c] = cell(c);
    const problem = checkCell('text', raw[c] as string);
    if (problem) errors.push({ column: c, message: problem });
  }
  if (errors.length > 0) return { raw, errors, parsed: null };

  const type = cell('type').toLowerCase().replace(/[ -]/g, '_');
  if (type !== 'single_choice' && type !== 'multiple_choice' && type !== 'true_false') {
    errors.push({
      column: 'type',
      message: 'must be single_choice, multiple_choice or true_false',
    });
    return { raw, errors, parsed: null };
  }
  const difficulty = cell('difficulty').toLowerCase() || 'medium';
  if (!['easy', 'medium', 'hard'].includes(difficulty))
    errors.push({ column: 'difficulty', message: 'must be easy, medium or hard' });
  const question = cell('question');
  if (!question) errors.push({ column: 'question', message: 'is required' });

  const input: QuestionInput = {
    type,
    difficulty: difficulty as 'easy',
    stem: doc(question || ' ') as never,
    tags: cell('tags')
      .split(/[;,]/)
      .map((t) => t.trim())
      .filter(Boolean),
  };
  const explanation = cell('explanation');
  if (explanation) input.explanation = doc(explanation) as never;
  const correct = cell('correct');
  if (type === 'true_false') {
    const v = correct.toLowerCase();
    if (v !== 'true' && v !== 'false')
      errors.push({ column: 'correct', message: 'must be true or false' });
    input.trueIsCorrect = v === 'true';
  } else {
    const opts = OPTION_COLUMNS.map((c) => cell(c));
    // options are the filled columns from the first; a gap in the middle is an error (it would shift the letters)
    const last = opts.reduce((n, v, i) => (v ? i + 1 : n), 0);
    for (let i = 0; i < last; i++)
      if (!opts[i])
        errors.push({
          column: OPTION_COLUMNS[i] as string,
          message: 'is empty between filled options',
        });
    const letters = new Set(
      correct
        .toUpperCase()
        .split(/[\s;,|]+/)
        .filter(Boolean),
    );
    for (const l of letters) {
      const i = l.length === 1 ? l.charCodeAt(0) - 65 : -1;
      if (i < 0 || i >= last)
        errors.push({ column: 'correct', message: `"${l}" is not one of the options` });
    }
    input.options = opts.slice(0, last).map((t, i) => ({
      text: doc(t || ' ') as never,
      correct: letters.has(String.fromCharCode(65 + i)),
    }));
    if (type === 'multiple_choice')
      input.partialCredit = YES.has(cell('partial_credit').toLowerCase());
  }
  if (errors.length > 0) return { raw, errors, parsed: null };
  try {
    const b = buildVersion(input);
    return {
      raw,
      errors,
      parsed: {
        type: b.type,
        difficulty: b.difficulty,
        tags: b.tags,
        presentation: b.presentation,
        answerKey: b.answerKey,
      },
    };
  } catch (err) {
    if (!(err instanceof InvalidQuestionError)) throw err;
    for (const d of err.details ?? []) {
      const m = /^options\[(\d)\]/.exec(d.path);
      const column = d.path.startsWith('stem')
        ? 'question'
        : m
          ? (OPTION_COLUMNS[Number(m[1])] as string)
          : d.path.startsWith('options') || d.path.startsWith('trueIsCorrect')
            ? 'correct'
            : d.path.startsWith('tags')
              ? 'tags'
              : d.path.startsWith('explanation')
                ? 'explanation'
                : 'question';
      errors.push({ column, message: d.message });
    }
    return { raw, errors, parsed: null };
  }
}
