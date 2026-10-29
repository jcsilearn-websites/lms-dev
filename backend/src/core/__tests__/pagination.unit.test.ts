import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../errors';
import {
  buildPage,
  buildTimePage,
  DEFAULT_PAGE_LIMIT,
  decodeTimeCursor,
  encodeTimeCursor,
  MAX_PAGE_LIMIT,
  normalizePage,
  normalizeTimePage,
} from '../pagination';
import { newId } from '../uuid';

describe('normalizePage', () => {
  it('defaults and bounds the limit (no unbounded queries)', () => {
    expect(normalizePage().limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(normalizePage({ limit: 10_000 }).limit).toBe(MAX_PAGE_LIMIT);
    expect(normalizePage({ limit: 0 }).limit).toBe(1);
    expect(normalizePage({ limit: -5 }).limit).toBe(1);
    expect(normalizePage({ limit: 7.9 }).limit).toBe(7);
  });

  it('accepts a UUID cursor and rejects anything else', () => {
    const after = newId();
    expect(normalizePage({ after })).toEqual({ limit: DEFAULT_PAGE_LIMIT, after });
    expect(() => normalizePage({ after: "x'; drop table" })).toThrow(BadRequestError);
  });
});

describe('buildPage', () => {
  const rows = (n: number) => Array.from({ length: n }, () => ({ id: newId() }));

  it('returns nextCursor = last id when there is another page', () => {
    const fetched = rows(4); // limit 3 + 1
    const page = buildPage(fetched, 3);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBe(fetched[2]?.id);
  });

  it('returns a null cursor on the last page and for an empty result', () => {
    expect(buildPage(rows(3), 3).nextCursor).toBeNull();
    expect(buildPage([], 3)).toEqual({ items: [], nextCursor: null });
  });
});

describe('time cursor (created_at, id)', () => {
  const id = newId();
  const createdAt = '2026-10-28T14:49:12.123456Z';

  it('round-trips and keeps the microseconds', () => {
    expect(decodeTimeCursor(encodeTimeCursor({ createdAt, id }))).toEqual({ createdAt, id });
  });

  it('rejects anything that is not a cursor this code produced', () => {
    for (const bad of [
      '',
      'abc',
      Buffer.from('x|y').toString('base64url'),
      Buffer.from(`nope|${id}`).toString('base64url'),
      Buffer.from(`${createdAt}|not-a-uuid`).toString('base64url'),
    ]) {
      expect(() => decodeTimeCursor(bad)).toThrow(BadRequestError);
    }
  });

  it('normalizes the limit like the id cursor and builds the next cursor from the last item', () => {
    expect(normalizeTimePage({ limit: 5000 }).limit).toBe(MAX_PAGE_LIMIT);
    const rows = [1, 2, 3].map((n) => ({
      id: newId(),
      createdAt: `2026-01-0${n}T00:00:00.000000Z`,
    }));
    const page = buildTimePage(rows, 2, (r) => r);
    expect(page.items).toHaveLength(2);
    expect(decodeTimeCursor(page.nextCursor as string)).toEqual(rows[1]);
    expect(buildTimePage(rows.slice(0, 2), 2, (r) => r).nextCursor).toBeNull();
  });
});
