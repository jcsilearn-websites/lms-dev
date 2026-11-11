// Small text helpers of the assignment screens (plain functions: unit tested, no React).

export const stamp = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';

/** 93784 -> "1 day 2 hours", 3700 -> "1 hour 1 minute", 45 -> "less than a minute". */
export function duration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (d > 0) parts.push(part(d, 'day'));
  if (h > 0 && parts.length < 2) parts.push(part(h, 'hour'));
  if (m > 0 && parts.length < 2) parts.push(part(m, 'minute'));
  return parts.length === 0 ? 'less than a minute' : parts.join(' ');
}

/** "10 points" / "1 point" / "7.5 points" */
export const points = (n: number): string =>
  `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '')} point${n === 1 ? '' : 's'}`;

export interface LatePolicyLike {
  latePolicy: 'none' | 'allowed';
  lateCutoffAt: string | null;
  penaltyKind: 'per_day' | 'flat';
  penaltyValue: number;
  penaltyCap: number;
  maxPoints: number;
}

/** The rule in words, with the points it means. */
export function latePolicyText(a: LatePolicyLike): string {
  if (a.latePolicy === 'none') return 'Work handed in after the due date is not accepted.';
  const each =
    a.penaltyKind === 'per_day'
      ? `${a.penaltyValue}% of the maximum (${points((a.maxPoints * a.penaltyValue) / 100)}) for every day you are late, a started day counts as a whole day`
      : `${a.penaltyValue}% of the maximum (${points((a.maxPoints * a.penaltyValue) / 100)}) once`;
  return `Late work is accepted until ${stamp(a.lateCutoffAt)}. The penalty is ${each}, and never more than ${a.penaltyCap}% (${points((a.maxPoints * a.penaltyCap) / 100)}).`;
}

/** Remaining time to `dueIso` by the SERVER's clock: `offsetMs` = server time minus the browser's at the moment it was read. */
export function remainingSeconds(dueIso: string, offsetMs: number, nowMs = Date.now()): number {
  return Math.floor((new Date(dueIso).getTime() - (nowMs + offsetMs)) / 1000);
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
