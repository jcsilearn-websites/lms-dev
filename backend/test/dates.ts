// Date helpers for tests that must agree with the product's day definition: the COLLEGE-LOCAL day (default zone Asia/Kolkata),
// never the database session's date and never the UTC date. See CLAUDE.md "Time-dependent tests".

/** The default college zone of a new college (lms.tenant_tz). */
export const COLLEGE_TZ = 'Asia/Kolkata';

/** 'YYYY-MM' of an instant as seen in a time zone (the month a college's usage is metered in). */
export function monthInZone(at: Date, timeZone: string = COLLEGE_TZ): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}
