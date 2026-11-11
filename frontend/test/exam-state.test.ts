import { describe, expect, it } from 'vitest';
import {
  dueWarning,
  ExamClock,
  formatRemaining,
  spokenRemaining,
  type WarningMinutes,
} from '../src/features/assessments/exam/examClock';
import {
  flaggedPositions,
  isAnswered,
  navItems,
  type PaperQuestion,
  parseNumber,
  unansweredPositions,
  wordCount,
} from '../src/features/assessments/exam/examState';

describe('the exam clock', () => {
  it('counts down from the SERVER deadline with a monotonic timer, whatever the device clock says', () => {
    let mono = 1_000;
    const clock = new ExamClock(() => mono);
    clock.sync('2026-01-01T10:00:00Z', '2026-01-01T10:30:00Z');
    expect(clock.remainingMs()).toBe(30 * 60_000);
    mono += 90_000;
    expect(clock.remainingMs()).toBe(28.5 * 60_000);
    // the learner sets the device clock back an hour: nothing changes (the timer is monotonic)
    const realNow = Date.now;
    Date.now = () => realNow() - 3_600_000;
    expect(clock.remainingMs()).toBe(28.5 * 60_000);
    Date.now = realNow;
    mono += 28.5 * 60_000 + 5_000;
    expect(clock.remainingMs()).toBe(0);
    expect(clock.isOver()).toBe(true);
  });

  it('re-syncs with every answer of the server (an accommodation or a closed window moves the deadline)', () => {
    let mono = 0;
    const clock = new ExamClock(() => mono);
    clock.sync('2026-01-01T10:00:00Z', '2026-01-01T10:30:00Z');
    mono += 10 * 60_000;
    clock.sync('2026-01-01T10:10:00Z', '2026-01-01T10:25:00Z');
    expect(clock.remainingMs()).toBe(15 * 60_000);
  });
});

describe('warnings at 10, 5 and 1 minute', () => {
  it('announces each threshold once, as it is crossed', () => {
    const shown = new Set<WarningMinutes>();
    expect(dueWarning(11 * 60_000, shown)).toBeNull();
    expect(dueWarning(10 * 60_000, shown)).toBe(10);
    expect(dueWarning(9 * 60_000, shown)).toBeNull();
    expect(dueWarning(5 * 60_000 - 1, shown)).toBe(5);
    expect(dueWarning(4 * 60_000, shown)).toBeNull();
    expect(dueWarning(60_000, shown)).toBe(1);
    expect(dueWarning(30_000, shown)).toBeNull();
    expect(dueWarning(0, shown)).toBeNull();
  });

  it('after a reload with 4 minutes left it says 5, not 10 and 5', () => {
    const shown = new Set<WarningMinutes>();
    expect(dueWarning(4 * 60_000, shown)).toBe(5);
    expect(dueWarning(4 * 60_000, shown)).toBeNull();
  });
});

describe('formatting', () => {
  it('formats the time left', () => {
    expect(formatRemaining(65 * 60_000 + 9_000)).toBe('1:05:09');
    expect(formatRemaining(5 * 60_000 + 9_000)).toBe('05:09');
    expect(formatRemaining(0)).toBe('00:00');
    expect(formatRemaining(1)).toBe('00:01');
  });
  it('speaks it in words', () => {
    expect(spokenRemaining(10 * 60_000)).toBe('10 minutes left');
    expect(spokenRemaining(61_000)).toBe('1 minute 1 second left');
    expect(spokenRemaining(0)).toBe('0 seconds left');
  });
});

const paper = (...qs: Partial<PaperQuestion>[]): PaperQuestion[] =>
  qs.map((q, i) => ({
    position: i + 1,
    type: 'single_choice',
    answer: null,
    flagged: false,
    ...q,
  }));

describe('question navigation', () => {
  it('knows what counts as answered, per type', () => {
    expect(isAnswered({ type: 'single_choice', answer: { o: ['a'] } })).toBe(true);
    expect(isAnswered({ type: 'single_choice', answer: { o: [] } })).toBe(false);
    expect(isAnswered({ type: 'multiple_choice', answer: null })).toBe(false);
    expect(isAnswered({ type: 'numeric', answer: { n: 0 } })).toBe(true);
    expect(isAnswered({ type: 'numeric', answer: { n: Number.NaN } })).toBe(false);
    expect(isAnswered({ type: 'short_answer', answer: { t: '  ' } })).toBe(false);
    expect(isAnswered({ type: 'essay', answer: { t: 'words' } })).toBe(true);
  });

  it('shows answered / unanswered / flagged / current in words, not colour alone', () => {
    const items = navItems(
      paper({ answer: { o: ['a'] } }, { flagged: true }, { answer: { o: ['b'] }, flagged: true }),
      2,
    );
    expect(items.map((i) => i.label)).toEqual([
      'Question 1, answered',
      'Question 2, unanswered, flagged for review, current',
      'Question 3, answered, flagged for review',
    ]);
    expect(items.map((i) => i.current)).toEqual([false, true, false]);
  });

  it('lists the unanswered and flagged questions for the submit dialog', () => {
    const qs = paper(
      { answer: { o: ['a'] } },
      {},
      { type: 'essay', answer: { t: 'x' }, flagged: true },
      { type: 'numeric' },
    );
    expect(unansweredPositions(qs)).toEqual([2, 4]);
    expect(flaggedPositions(qs)).toEqual([3]);
  });

  it('counts words and parses numbers the way a learner types them', () => {
    expect(wordCount('  one  two\nthree ')).toBe(3);
    expect(wordCount('')).toBe(0);
    expect(parseNumber('3,14')).toBe(3.14);
    expect(parseNumber(' -2.5e3 ')).toBe(-2500);
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('1 2')).toBeNull();
  });
});
