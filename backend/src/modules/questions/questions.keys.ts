import { randomBytes } from 'node:crypto';
import type { QuestionDto, QuestionInput } from '../../contracts';
import type { ErrorDetail } from '../../core/errors';
import { normalizeRichText } from '../content';
import { InvalidQuestionError } from './questions.errors';

// Turns what an instructor sends into the two stored halves of a version, and back:
//   presentation: what a learner may be sent (stem, options WITHOUT correctness, images, word limit)
//   answerKey:    what must never reach a learner before release (correct options, numeric value, accepted answers, explanation)
// Pure functions: no database, unit tested.

type Doc = { type: 'doc'; content?: unknown[] };
export interface Presentation {
  stem: Doc;
  options?: { id: string; text: Doc }[];
  images?: { fileId: string; alt: string }[];
  maxWords?: number;
}
export type AnswerKey = {
  correct?: string[];
  partial?: boolean;
  value?: number;
  tolerance?: number;
  mode?: string;
  accepted?: string[];
  explanation?: Doc;
};

export interface BuiltVersion {
  type: QuestionInput['type'];
  difficulty: 'easy' | 'medium' | 'hard';
  presentation: Presentation;
  answerKey: AnswerKey;
  tags: string[];
  fileIds: string[];
}

/**
 * A fresh option id: 12 random hex characters. NEVER the position or the authoring order of the option (a learner who
 * sees the ids must learn nothing from them); an option kept through an edit keeps its id (that is what lets a regrade
 * re-score past attempts against a corrected key), a new option gets a new random one.
 */
export const randomOptionId = (): string => randomBytes(6).toString('hex');

/** The text comparison of short answers (the SQL norm_text does the same): NFKC, trim, collapse white space, lower case. */
export const normalizeText = (s: string): string =>
  s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

const TAG = /^[a-z0-9][a-z0-9 ._+-]{0,39}$/;
export function cleanTags(tags: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const raw of tags ?? []) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!TAG.test(t))
      throw new InvalidQuestionError([{ path: 'tags', message: `"${raw}" is not a valid tag` }]);
    out.add(t);
  }
  return [...out];
}

function rich(input: unknown, path: string, problems: ErrorDetail[]): Doc | null {
  const r = normalizeRichText(input);
  if (r.ok) return r.doc as Doc;
  for (const p of r.problems.slice(0, 3))
    problems.push({ path: `${path}${p.path ? `.${p.path}` : ''}`, message: p.message });
  return null;
}

/**
 * Validates a question and builds both halves. `previousOptionIds`: the option ids of the version being edited (an
 * option may keep one of them; any other id is refused). `previousPresentation`: a true / false question keeps the ids
 * of its two options across versions.
 */
export function buildVersion(
  input: QuestionInput,
  previous?: { optionIds: readonly string[]; type: string },
): BuiltVersion {
  const problems: ErrorDetail[] = [];
  const stem = rich(input.stem, 'stem', problems);
  const explanation =
    input.explanation !== undefined ? rich(input.explanation, 'explanation', problems) : null;
  const presentation: Presentation = { stem: stem ?? { type: 'doc' } };
  const answerKey: AnswerKey = {};
  const type = input.type;

  if (type === 'single_choice' || type === 'multiple_choice') {
    const opts = input.options ?? [];
    if (opts.length < 2) problems.push({ path: 'options', message: 'give at least two options' });
    const known = new Set(previous?.optionIds ?? []);
    const seen = new Set<string>();
    const built: { id: string; text: Doc }[] = [];
    const correct: string[] = [];
    for (const [i, o] of opts.entries()) {
      let id = o.id;
      if (id !== undefined) {
        if (!known.has(id) || seen.has(id)) {
          problems.push({ path: `options[${i}].id`, message: 'unknown or repeated option id' });
          continue;
        }
      } else {
        do id = randomOptionId();
        while (seen.has(id) || known.has(id));
      }
      seen.add(id);
      const text = rich(o.text, `options[${i}].text`, problems);
      if (!text || !(text.content && text.content.length > 0))
        problems.push({ path: `options[${i}].text`, message: 'an option needs text' });
      built.push({ id, text: text ?? { type: 'doc' } });
      if (o.correct) correct.push(id);
    }
    if (type === 'single_choice' && correct.length !== 1)
      problems.push({ path: 'options', message: 'mark exactly one option as correct' });
    if (type === 'multiple_choice' && correct.length < 1)
      problems.push({ path: 'options', message: 'mark at least one option as correct' });
    presentation.options = built;
    answerKey.correct = correct;
    if (type === 'multiple_choice') answerKey.partial = input.partialCredit === true;
  } else if (type === 'true_false') {
    if (input.trueIsCorrect === undefined)
      problems.push({ path: 'trueIsCorrect', message: 'say whether the statement is true' });
    const keep = previous?.type === 'true_false' ? previous.optionIds : [];
    const trueId = keep[0] ?? randomOptionId();
    let falseId = keep[1] ?? randomOptionId();
    while (falseId === trueId) falseId = randomOptionId();
    const text = (t: string): Doc => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
    });
    presentation.options = [
      { id: trueId, text: text('True') },
      { id: falseId, text: text('False') },
    ];
    answerKey.correct = [input.trueIsCorrect === false ? falseId : trueId];
  } else if (type === 'numeric') {
    const n = input.numeric;
    if (!n || !Number.isFinite(n.value))
      problems.push({ path: 'numeric', message: 'give the correct number' });
    else {
      answerKey.value = n.value;
      answerKey.tolerance = n.tolerance ?? 0;
      answerKey.mode = n.mode ?? 'absolute';
      if (answerKey.mode === 'percent' && answerKey.tolerance > 100)
        problems.push({
          path: 'numeric.tolerance',
          message: 'a percentage tolerance is at most 100',
        });
    }
  } else if (type === 'short_answer') {
    const s = input.shortAnswer ?? { mode: 'auto' as const };
    answerKey.mode = s.mode;
    if (s.mode === 'auto') {
      const accepted = [...new Set((s.accepted ?? []).map((a) => a.trim()).filter(Boolean))];
      if (accepted.length === 0)
        problems.push({
          path: 'shortAnswer.accepted',
          message: 'give at least one accepted answer, or choose manual grading',
        });
      answerKey.accepted = accepted;
    }
  } else if (input.maxWords !== undefined) {
    presentation.maxWords = input.maxWords;
  }

  if (input.images && input.images.length > 0) {
    const ids = input.images.map((i) => i.fileId);
    if (new Set(ids).size !== ids.length)
      problems.push({ path: 'images', message: 'an image is listed twice' });
    presentation.images = input.images.map((i) => ({ fileId: i.fileId, alt: i.alt.trim() }));
  }
  if (explanation) answerKey.explanation = explanation;
  if (problems.length > 0) throw new InvalidQuestionError(problems);
  return {
    type,
    difficulty: input.difficulty ?? 'medium',
    presentation,
    answerKey,
    tags: cleanTags(input.tags),
    fileIds: (presentation.images ?? []).map((i) => i.fileId),
  };
}

/** The instructor's view of a stored version. */
export function toQuestionDto(r: {
  id: string;
  courseId: string;
  status: 'active' | 'archived';
  version: number;
  latestVersion: number;
  versionId: string;
  type: QuestionDto['type'];
  difficulty: QuestionDto['difficulty'];
  presentation: Presentation;
  answerKey: AnswerKey;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}): QuestionDto {
  const p = r.presentation;
  const k = r.answerKey;
  const correct = new Set(k.correct ?? []);
  const options =
    r.type === 'true_false'
      ? []
      : (p.options ?? []).map((o) => ({ id: o.id, text: o.text, correct: correct.has(o.id) }));
  const trueOpt = r.type === 'true_false' ? p.options?.[0] : undefined;
  return {
    id: r.id,
    courseId: r.courseId,
    status: r.status,
    version: Number(r.version),
    latestVersion: Number(r.latestVersion),
    versionId: r.versionId,
    type: r.type,
    difficulty: r.difficulty,
    stem: p.stem as never,
    options: options as never,
    images: p.images ?? [],
    partialCredit: k.partial === true,
    trueIsCorrect: trueOpt ? correct.has(trueOpt.id) : null,
    numeric:
      r.type === 'numeric' && typeof k.value === 'number'
        ? {
            value: k.value,
            tolerance: k.tolerance ?? 0,
            mode: (k.mode as 'absolute' | 'percent') ?? 'absolute',
          }
        : null,
    shortAnswer:
      r.type === 'short_answer'
        ? { mode: (k.mode as 'auto' | 'manual') ?? 'auto', accepted: k.accepted ?? [] }
        : null,
    maxWords: p.maxWords ?? null,
    explanation: (k.explanation as never) ?? null,
    tags: r.tags,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}
