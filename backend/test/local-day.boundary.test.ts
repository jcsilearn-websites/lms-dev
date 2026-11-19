import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// The product's day is the COLLEGE-LOCAL day (default zone Asia/Kolkata, UTC+05:30, no DST), never the database session's date.
// Local midnight is 18:30 UTC. These tests pass EXPLICIT instants to the functions that take one (p_now / p_ts / p_at), so they do not
// depend on the real clock, on the time of day the suite runs, or on the session TimeZone: the boundary 18:29 / 18:31 UTC is tested
// on every run. Cases: the day boundary, a month end, 31 December, a leap day (2028-02-29), a Sunday -> Monday week change.
// (2026-11-22 is a Sunday.) Written after CI failed only between 18:30 and 24:00 UTC (docs: CLAUDE.md "Time-dependent tests").

const TZ = 'Asia/Kolkata';
let owner: pg.Pool;
let A: AuthFixture;

beforeAll(async () => {
  owner = testOwnerPool();
  A = await createAuthFixture(owner, 'ld-b');
});
afterAll(async () => {
  await owner.end();
});

const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await owner.query(sql, params)).rows as T[];
const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
  (await rows<T>(sql, params))[0] as T;
/** ISO instant in UTC, for readable expectations. */
const iso = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

describe('the local day: lms.local_day and lms.next_local_midnight', () => {
  const cases: [instant: string, day: string, nextMidnight: string, note: string][] = [
    [
      '2026-11-18T18:29:59Z',
      '2026-11-18',
      '2026-11-18T18:30:00Z',
      '18:29:59 UTC is still 23:59:59 IST',
    ],
    [
      '2026-11-18T18:30:00Z',
      '2026-11-19',
      '2026-11-19T18:30:00Z',
      '18:30:00 UTC is local midnight',
    ],
    [
      '2026-11-18T18:31:00Z',
      '2026-11-19',
      '2026-11-19T18:30:00Z',
      '18:31 UTC is 00:01 IST of the next day',
    ],
    ['2026-11-18T23:59:00Z', '2026-11-19', '2026-11-19T18:30:00Z', 'UTC 23:59 is 05:29 IST'],
    [
      '2026-11-19T00:01:00Z',
      '2026-11-19',
      '2026-11-19T18:30:00Z',
      'UTC midnight is NOT a boundary for this college',
    ],
    ['2026-11-30T18:29:00Z', '2026-11-30', '2026-11-30T18:30:00Z', 'last day of a month, before'],
    [
      '2026-11-30T18:31:00Z',
      '2026-12-01',
      '2026-12-01T18:30:00Z',
      'last day of a month, after: the month changes',
    ],
    ['2026-12-31T18:29:00Z', '2026-12-31', '2026-12-31T18:30:00Z', '31 December, before'],
    [
      '2026-12-31T18:31:00Z',
      '2027-01-01',
      '2027-01-01T18:30:00Z',
      '31 December, after: the year changes',
    ],
    ['2028-02-28T18:31:00Z', '2028-02-29', '2028-02-29T18:30:00Z', 'a leap day exists'],
    ['2028-02-29T18:29:00Z', '2028-02-29', '2028-02-29T18:30:00Z', '29 February, before'],
    ['2028-02-29T18:31:00Z', '2028-03-01', '2028-03-01T18:30:00Z', '29 February, after'],
    ['2027-02-28T18:31:00Z', '2027-03-01', '2027-03-01T18:30:00Z', 'no leap day in 2027'],
  ];
  for (const [instant, day, next, note] of cases) {
    it(`${instant}: local day ${day} (${note})`, async () => {
      const r = await one<{ day: string; next: string }>(
        `SELECT lms.local_day($1::timestamptz, $2)::text AS day, ${iso('lms.next_local_midnight($1::timestamptz, $2)')} AS next`,
        [instant, TZ],
      );
      expect(r).toEqual({ day, next });
    });
  }

  it('the college zone is the default of a new college (the other tests rely on it)', async () => {
    expect((await one<{ tz: string }>(`SELECT lms.tenant_tz($1) AS tz`, [A.tenantId])).tz).toBe(TZ);
  });

  it('Sunday -> Monday: the ISO weekday changes at local midnight (18:30 UTC), not at UTC midnight', async () => {
    const dow = async (at: string) =>
      (
        await one<{ d: number }>(
          `SELECT extract(isodow FROM lms.local_day($1::timestamptz, $2))::int AS d`,
          [at, TZ],
        )
      ).d;
    expect(await dow('2026-11-22T18:29:00Z')).toBe(7); // Sunday 23:59 IST
    expect(await dow('2026-11-22T18:31:00Z')).toBe(1); // Monday 00:01 IST
    expect(await dow('2026-11-22T23:59:00Z')).toBe(1);
    expect(await dow('2026-11-23T00:01:00Z')).toBe(1);
  });
});

describe('deadlines are instants: a local midnight in between changes nothing', () => {
  const penalty = async (due: string, submitted: string) =>
    one<{ late: number; pct: string }>(
      `SELECT ceil(extract(epoch FROM $2::timestamptz - $1::timestamptz))::int AS late,
              lms.assignment_penalty_percent('per_day', 10, 50, ceil(extract(epoch FROM $2::timestamptz - $1::timestamptz))::int)::text AS pct`,
      [due, submitted],
    );

  it('90 seconds late is one started day, whether or not it crosses 18:30 UTC (local midnight)', async () => {
    const across = await penalty('2026-11-18T18:29:30Z', '2026-11-18T18:31:00Z'); // straddles IST midnight
    const within = await penalty('2026-11-18T10:00:00Z', '2026-11-18T10:01:30Z');
    expect(across).toEqual({ late: 90, pct: '10' });
    expect(within).toEqual(across);
  });

  it('started days count elapsed 24 h periods: exactly 24 h = 1 day, one second more = 2, across a month end and a leap day', async () => {
    expect((await penalty('2026-11-18T18:29:00Z', '2026-11-19T18:29:00Z')).pct).toBe('10');
    expect((await penalty('2026-11-18T18:29:00Z', '2026-11-19T18:29:01Z')).pct).toBe('20');
    expect((await penalty('2026-11-30T18:29:00Z', '2026-12-01T18:31:00Z')).pct).toBe('20'); // 24 h 2 min: month end
    expect((await penalty('2028-02-28T18:29:00Z', '2028-03-01T18:29:00Z')).pct).toBe('20'); // 48 h over a leap day
    expect((await penalty('2027-02-28T18:29:00Z', '2027-03-01T18:29:00Z')).pct).toBe('10'); // 24 h, no leap day
  });

  it('quiet hours (22:00-07:00 college time) release a held notification at 07:00 IST of the right DAY', async () => {
    const settings = JSON.stringify({
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
    });
    const release = async (at: string) =>
      (
        await one<{ r: string }>(
          `SELECT ${iso('lms.notify_quiet_release($1::jsonb, $2, $3::timestamptz)')} AS r`,
          [settings, TZ, at],
        )
      ).r;
    // 23:59 IST on the 18th and 00:01 IST on the 19th are BOTH released at 07:00 IST on the 19th (01:30 UTC), not the 20th
    expect(await release('2026-11-18T18:29:00Z')).toBe('2026-11-19T01:30:00Z');
    expect(await release('2026-11-18T18:31:00Z')).toBe('2026-11-19T01:30:00Z');
    expect(await release('2026-11-19T01:29:00Z')).toBe('2026-11-19T01:30:00Z'); // 06:59 IST: still quiet
    expect(await release('2026-11-19T01:31:00Z')).toBe('2026-11-19T01:31:00Z'); // 07:01 IST: sent at once
    expect(await release('2026-11-18T16:29:00Z')).toBe('2026-11-18T16:29:00Z'); // 21:59 IST: not quiet yet
    expect(await release('2026-11-30T18:31:00Z')).toBe('2026-12-01T01:30:00Z'); // over a month end
    expect(await release('2026-12-31T18:31:00Z')).toBe('2027-01-01T01:30:00Z'); // over a year end
  });
});

describe('daily rollups use the local day', () => {
  // its own college: the activity below must not feed the streak tests that follow
  let R: AuthFixture;
  beforeAll(async () => {
    R = await createAuthFixture(owner, 'ld-b2');
  });

  it('an activity at 18:29 UTC belongs to the 18th, one at 18:31 UTC to the 19th, and the window ends at the local today', async () => {
    const [u1, u2] = [R.adminUserId, R.memberUserId];
    const touch = async (user: string, at: string) =>
      (
        await one<{ next: string }>(
          `SELECT ${iso('lms.activity_touch($1, $2, $3::timestamptz)')} AS next`,
          [R.tenantId, user, at],
        )
      ).next;
    const days = () =>
      rows<{ day: string; active_users: number }>(
        `SELECT day::text AS day, active_users FROM lms.rollup_tenant_day WHERE tenant_id = $1 ORDER BY day`,
        [R.tenantId],
      );
    const run = (at: string) =>
      owner.query(`SELECT lms.rollup_run_tenant($1, $2::timestamptz, 500)`, [R.tenantId, at]);

    // the call tells the caller when the next local day starts: 18:30 UTC, and the day after for an activity after it
    expect(await touch(u1, '2026-11-18T18:29:00Z')).toBe('2026-11-18T18:30:00Z');
    await run('2026-11-18T18:29:00Z');
    expect(await days()).toEqual([{ day: '2026-11-18', active_users: 1 }]);

    expect(await touch(u2, '2026-11-18T18:31:00Z')).toBe('2026-11-19T18:30:00Z');
    // a run just BEFORE local midnight must not roll up the 19th yet ...
    await run('2026-11-18T18:29:30Z');
    expect(await days()).toEqual([{ day: '2026-11-18', active_users: 1 }]);
    // ... and one just after does
    await run('2026-11-18T18:31:00Z');
    expect(await days()).toEqual([
      { day: '2026-11-18', active_users: 1 },
      { day: '2026-11-19', active_users: 1 },
    ]);
    // one row per user and LOCAL day: the same user again on the same local day changes nothing
    await touch(u2, '2026-11-19T10:00:00Z');
    expect(
      (
        await rows(`SELECT 1 FROM lms.member_activity_days WHERE tenant_id = $1 AND user_id = $2`, [
          R.tenantId,
          u2,
        ])
      ).length,
    ).toBe(1);
  });
});

describe('streaks and the week of the learner dashboard use the local day', () => {
  const dash = async (at: string) =>
    one<{ r: { today: string; streak: number; week: { date: string; active: boolean }[] } }>(
      `SELECT lms.learner_dashboard($1, $2, $3::timestamptz) AS r`,
      [A.tenantId, A.memberUserId, at],
    ).then((x) => x.r);

  beforeAll(async () => {
    // one learner-ish user, active on these (local) days: 17-18 Nov, 22 Nov, 29-30 Nov, 30-31 Dec, 28-29 Feb 2028
    for (const at of [
      '2026-11-17T10:00:00Z',
      '2026-11-18T10:00:00Z',
      '2026-11-22T10:00:00Z',
      '2026-11-29T10:00:00Z',
      '2026-11-30T10:00:00Z',
      '2026-12-30T10:00:00Z',
      '2026-12-31T10:00:00Z',
      '2028-02-28T10:00:00Z',
      '2028-02-29T10:00:00Z',
    ])
      await owner.query(`SELECT lms.activity_touch($1, $2, $3::timestamptz)`, [
        A.tenantId,
        A.memberUserId,
        at,
      ]);
  });

  it('18:29 UTC is still the 18th; 18:31 UTC is the 19th, and yesterday keeps the streak alive', async () => {
    const before = await dash('2026-11-18T18:29:00Z');
    expect(before.today).toBe('2026-11-18');
    expect(before.streak).toBe(2); // 17th and 18th
    const after = await dash('2026-11-18T18:31:00Z');
    expect(after.today).toBe('2026-11-19');
    expect(after.streak).toBe(2); // not active "today" yet, but yesterday counts
    // a whole local day with no activity ends it
    const gone = await dash('2026-11-19T18:31:00Z');
    expect(gone.today).toBe('2026-11-20');
    expect(gone.streak).toBe(0);
  });

  it('the week runs Monday to Sunday of the LOCAL date: Sunday 23:59 IST and Monday 00:01 IST are different weeks', async () => {
    const sunday = await dash('2026-11-22T18:29:00Z');
    expect(sunday.today).toBe('2026-11-22');
    expect(sunday.week[0]?.date).toBe('2026-11-16');
    expect(sunday.week[6]).toEqual({ date: '2026-11-22', active: true });
    const monday = await dash('2026-11-22T18:31:00Z');
    expect(monday.today).toBe('2026-11-23');
    expect(monday.week[0]?.date).toBe('2026-11-23');
    expect(monday.week.map((d) => d.active)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(monday.streak).toBe(1); // Sunday the 22nd, still "yesterday"
  });

  it('a streak runs across a month end, a year end and a leap day', async () => {
    expect((await dash('2026-11-30T18:31:00Z')).streak).toBe(2); // 29, 30 Nov; today is 1 Dec
    expect((await dash('2026-12-31T18:31:00Z')).today).toBe('2027-01-01');
    expect((await dash('2026-12-31T18:31:00Z')).streak).toBe(2); // 30, 31 Dec; today is 1 Jan
    expect((await dash('2028-02-29T18:31:00Z')).today).toBe('2028-03-01');
    expect((await dash('2028-02-29T18:31:00Z')).streak).toBe(2); // 28 and 29 Feb
    expect((await dash('2028-02-29T18:29:00Z')).streak).toBe(2); // still the 29th
  });
});

describe('notification digests are keyed by the local date and wait for the digest hour', () => {
  it('a daily run happens once per LOCAL date, from the digest hour; the weekly run on the local Monday', async () => {
    const hour = Number(
      (
        await one<{ h: string }>(`SELECT lms.notify_settings($1) ->> 'digestHour' AS h`, [
          A.tenantId,
        ])
      ).h,
    );
    expect(hour).toBeGreaterThan(0); // the cases below need "00:01 is before the digest hour"
    const at = async (date: string, h: number) =>
      (
        await one<{ at: string }>(
          `SELECT ${iso(`((($1::date + make_time($2, 0, 0))::timestamp) AT TIME ZONE '${TZ}')`)} AS at`,
          [date, h],
        )
      ).at;
    const scan = (when: string) =>
      owner.query(`SELECT lms.notify_scan_tenant($1, $2::timestamptz)`, [A.tenantId, when]);
    const runs = async () =>
      (
        await rows<{ kind: string; d: string }>(
          `SELECT kind, local_date::text AS d FROM lms.notify_runs WHERE tenant_id = $1 ORDER BY kind, local_date`,
          [A.tenantId],
        )
      ).map((r) => `${r.kind} ${r.d}`);

    // Wednesday 18th, 23:59 IST: the day's digest is due (23 >= hour) and is keyed by the 18th
    await scan('2026-11-18T18:29:00Z');
    expect(await runs()).toEqual(['daily 2026-11-18']);
    // 00:01 IST on the 19th: a new local date, but BEFORE the digest hour: nothing new yet
    await scan('2026-11-18T18:31:00Z');
    expect(await runs()).toEqual(['daily 2026-11-18']);
    // at the digest hour of the 19th: the digest of the 19th
    await scan(await at('2026-11-19', hour));
    expect(await runs()).toEqual(['daily 2026-11-18', 'daily 2026-11-19']);
    // the same scan again is idempotent
    await scan(await at('2026-11-19', hour));
    expect(await runs()).toEqual(['daily 2026-11-18', 'daily 2026-11-19']);

    // Sunday 22nd 23:59 IST: a daily run (the 22nd) but no weekly summary (it is not Monday)
    await scan('2026-11-22T18:29:00Z');
    // Monday 00:01 IST: nothing before the digest hour
    await scan('2026-11-22T18:31:00Z');
    expect(await runs()).toEqual(['daily 2026-11-18', 'daily 2026-11-19', 'daily 2026-11-22']);
    // Monday at the digest hour: the daily of the 23rd AND the weekly summary, keyed by the 23rd
    await scan(await at('2026-11-23', hour));
    expect(await runs()).toEqual([
      'daily 2026-11-18',
      'daily 2026-11-19',
      'daily 2026-11-22',
      'daily 2026-11-23',
      'weekly 2026-11-23',
    ]);
  });
});
