/**
 * A Postgres array literal ({"a","b",NULL}) for a bound parameter that is cast with ::text[] / ::uuid[] /
 * ::jsonb[]... Every element is quoted and escaped, so any text (commas, quotes, braces, backslashes) is
 * carried as data. Used to send a whole batch of rows as a handful of parameters to UNNEST.
 */
export function pgArray(values: readonly (string | null | undefined)[]): string {
  const items = values.map((v) =>
    v === null || v === undefined ? 'NULL' : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  );
  return `{${items.join(',')}}`;
}
