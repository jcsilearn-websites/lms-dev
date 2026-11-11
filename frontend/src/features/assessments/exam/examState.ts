// Pure helpers of the exam screen: what counts as answered, how a question shows in the navigation, which questions a
// submit would leave unanswered. No React, no network: unit tested.

export interface PaperAnswer {
  o?: string[];
  n?: number;
  t?: string;
}

export interface PaperQuestion {
  position: number;
  type: string;
  answer: PaperAnswer | null;
  flagged: boolean;
}

/** An answer counts when it carries something: a chosen option, a number, or text other than white space. */
export function isAnswered(q: Pick<PaperQuestion, 'type' | 'answer'>): boolean {
  const a = q.answer;
  if (!a) return false;
  if (q.type === 'numeric') return typeof a.n === 'number' && Number.isFinite(a.n);
  if (q.type === 'short_answer' || q.type === 'essay') return (a.t ?? '').trim().length > 0;
  return Array.isArray(a.o) && a.o.length > 0;
}

export type NavStatus = 'answered' | 'unanswered';

export interface NavItem {
  position: number;
  status: NavStatus;
  flagged: boolean;
  current: boolean;
  /** what a screen reader hears: never colour alone */
  label: string;
}

export function navItems(questions: readonly PaperQuestion[], current: number): NavItem[] {
  return questions.map((q) => {
    const status: NavStatus = isAnswered(q) ? 'answered' : 'unanswered';
    const parts = [`Question ${q.position}`, status, ...(q.flagged ? ['flagged for review'] : [])];
    if (q.position === current) parts.push('current');
    return {
      position: q.position,
      status,
      flagged: q.flagged,
      current: q.position === current,
      label: parts.join(', '),
    };
  });
}

/** The positions a submit would leave unanswered (what the confirm dialog lists). */
export function unansweredPositions(questions: readonly PaperQuestion[]): number[] {
  return questions.filter((q) => !isAnswered(q)).map((q) => q.position);
}

export function flaggedPositions(questions: readonly PaperQuestion[]): number[] {
  return questions.filter((q) => q.flagged).map((q) => q.position);
}

/** The words of an essay (for the soft limit shown under the box). */
export function wordCount(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

/** Parses what was typed in a numeric box; null for anything that is not a plain number. */
export function parseNumber(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
