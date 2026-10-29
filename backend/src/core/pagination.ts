import { BadRequestError } from './errors';
import { isUuid } from './uuid';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/** Keyset pagination over UUIDv7 ids (time-ordered): `after` is the last id of the previous page. */
export interface PageRequest {
  limit?: number | undefined;
  after?: string | undefined;
}

export interface Page<T> {
  items: T[];
  /** Pass as `after` to fetch the next page; null on the last page. */
  nextCursor: string | null;
}

export interface NormalizedPage {
  limit: number;
  after?: string;
}

/** Validates and bounds a page request. Every list query must go through this: no unbounded queries. */
export function normalizePage(req: PageRequest = {}): NormalizedPage {
  const limit = Math.min(Math.max(Math.trunc(req.limit ?? DEFAULT_PAGE_LIMIT), 1), MAX_PAGE_LIMIT);
  if (req.after !== undefined && !isUuid(req.after)) {
    throw new BadRequestError('invalid_cursor', 'The pagination cursor is not valid');
  }
  return req.after === undefined ? { limit } : { limit, after: req.after };
}

/** Repositories fetch `limit + 1` rows; this trims the extra row and derives the next cursor. */
export function buildPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? last.id : null };
}

/**
 * Keyset pagination over (created_at DESC, id DESC) for logs filtered by date. The cursor is opaque
 * to clients: base64url of "<created_at as YYYY-MM-DDTHH:MM:SS.ffffffZ>|<id>" of the last row of the previous page. The
 * timestamp keeps its microseconds as a string, so a row is never skipped or repeated by rounding.
 */
export interface TimeCursor {
  createdAt: string;
  id: string;
}

const CURSOR_SHAPE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f-]{36})$/i;

export function encodeTimeCursor(cursor: TimeCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeTimeCursor(raw: string): TimeCursor {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const m = CURSOR_SHAPE.exec(text);
  if (!m || !isUuid(m[2] as string) || Number.isNaN(Date.parse(m[1] as string))) {
    throw new BadRequestError('invalid_cursor', 'The pagination cursor is not valid');
  }
  return { createdAt: m[1] as string, id: m[2] as string };
}

export interface NormalizedTimePage {
  limit: number;
  after?: TimeCursor;
}

export function normalizeTimePage(
  req: { limit?: number | undefined; after?: string | undefined } = {},
): NormalizedTimePage {
  const limit = Math.min(Math.max(Math.trunc(req.limit ?? DEFAULT_PAGE_LIMIT), 1), MAX_PAGE_LIMIT);
  return req.after === undefined ? { limit } : { limit, after: decodeTimeCursor(req.after) };
}

/** `cursorOf` derives the cursor parts from the last row (created_at must be the exact DB text). */
export function buildTimePage<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => TimeCursor,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeTimeCursor(cursorOf(last)) : null };
}
