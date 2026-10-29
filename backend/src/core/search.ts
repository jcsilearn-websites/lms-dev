import { BadRequestError } from './errors';

/**
 * A LIKE prefix pattern for a user-typed search term: trimmed, lowercased, with LIKE wildcards and
 * the escape character neutralised, followed by %. Search keys are stored lowercased, so
 * `search_name LIKE <pattern>` is an index-backed prefix scan (text_pattern_ops).
 */
export function prefixPattern(term: string, minLength = 2): string {
  const t = term.trim().toLowerCase();
  if (t.length < minLength) {
    throw new BadRequestError('search_too_short', `Search needs at least ${minLength} characters`);
  }
  return `${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
