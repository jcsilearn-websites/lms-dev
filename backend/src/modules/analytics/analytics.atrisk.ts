import type { AtRiskRule, AtRiskSettings } from '../../contracts';

// The at-risk rules in words. The FLAGS come from the database (lms.atrisk_flags); this file turns the evidence rows into
// sentences a person can check. There is no score here, by design: a learner is flagged by the rules that fired, nothing more.

type Rec = Record<string, unknown>;

export interface AtRiskRuleText {
  rule: AtRiskRule;
  summary: string;
  evidence: string[];
}

/** A date in the college's time zone, e.g. "4 Nov 2026". */
export function formatDay(value: unknown, timeZone: string): string {
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MAX_EVIDENCE = 10;

export function describeRules(
  row: Rec,
  settings: AtRiskSettings,
  timeZone: string,
  now: Date,
): AtRiskRuleText[] {
  const out: AtRiskRuleText[] = [];
  if (row.behind === true) {
    const items = (row.behindItems as { title: string; since: string }[]) ?? [];
    out.push({
      rule: 'behind',
      summary: `Behind on ${plural(items.length, 'required item')} (open for more than the course's limit)`,
      evidence: items
        .slice(0, MAX_EVIDENCE)
        .map((i) => `${i.title}: open since ${formatDay(i.since, timeZone)}, not done`),
    });
  }
  if (row.missed === true) {
    const items = (row.missedItems as { title: string; at: string }[]) ?? [];
    out.push({
      rule: 'missed_deadlines',
      summary: `Missed ${plural(Number(row.missedCount ?? items.length), 'deadline')} (flagged from ${settings.missedDeadlines})`,
      evidence: items
        .slice(0, MAX_EVIDENCE)
        .map((i) => `${i.title}: due ${formatDay(i.at, timeZone)}, nothing handed in`),
    });
  }
  if (row.low === true) {
    const items = (row.scoreItems as { title: string; percent: number }[]) ?? [];
    out.push({
      rule: 'low_score',
      summary: `Average of released scores ${Number(row.avgScore).toFixed(1)}% is below the pass mark of ${settings.passMarkPercent}%`,
      evidence: items
        .slice(0, MAX_EVIDENCE)
        .map((i) => `${i.title}: ${Number(i.percent).toFixed(1)}%`),
    });
  }
  if (row.inactive === true) {
    const last = row.lastActivityAt as string | null;
    const since = new Date(String(last ?? row.enrolledAt));
    const days = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 86_400_000));
    out.push({
      rule: 'inactive',
      summary: `No activity for ${plural(days, 'day')} (flagged from ${settings.inactiveDays})`,
      evidence: [
        last
          ? `Last activity: ${formatDay(last, timeZone)}`
          : `No activity since joining on ${formatDay(row.enrolledAt, timeZone)}`,
      ],
    });
  }
  return out;
}
