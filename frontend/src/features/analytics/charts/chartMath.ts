// Plain functions behind the hand-written SVG charts: scales, tick values and the TEXT SUMMARY every chart carries.
// No chart library: a bar, a line, a funnel and a heat strip are a few hundred lines in total (see ADR 0020) and need
// exactly the data the accessible table next to them shows.

export interface Point {
  label: string;
  value: number;
}

/** The smallest "round" number >= max (1, 2, 5 x 10^n), so axis labels are readable. Never 0. */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  const f = max / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** n + 1 evenly spaced ticks from 0 to `top` (inclusive). */
export function ticks(top: number, n = 4): number[] {
  return Array.from({ length: n + 1 }, (_, i) => (top * i) / n);
}

/** Maps value in [0, top] to [0, length]. */
export function scale(value: number, top: number, length: number): number {
  if (top <= 0) return 0;
  return Math.max(0, Math.min(length, (value / top) * length));
}

export function formatNumber(value: number, unit = ''): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  const text = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(rounded);
  return unit === '%' ? `${text}%` : unit ? `${text} ${unit}` : text;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "12 days: highest 40 (4 Nov), lowest 2 (9 Nov), latest 18." for a series over time or categories. */
export function describeSeries(points: readonly Point[], unit = '', noun = 'point'): string {
  if (points.length === 0) return 'No data to show yet.';
  let hi = points[0] as Point;
  let lo = points[0] as Point;
  for (const p of points) {
    if (p.value > hi.value) hi = p;
    if (p.value < lo.value) lo = p;
  }
  const last = points[points.length - 1] as Point;
  const sum = points.reduce((a, p) => a + p.value, 0);
  const out = [
    `${plural(points.length, noun)}: highest ${formatNumber(hi.value, unit)} (${hi.label})`,
    `lowest ${formatNumber(lo.value, unit)} (${lo.label})`,
    `latest ${formatNumber(last.value, unit)} (${last.label})`,
  ];
  if (!unit.includes('%')) out.push(`total ${formatNumber(sum, unit)}`);
  return `${out.join(', ')}.`;
}

/** The funnel in words: how many reached each stage and where the biggest drop is. */
export function describeFunnel(stages: readonly Point[]): string {
  if (stages.length === 0) return 'No modules to show yet.';
  const first = stages[0] as Point;
  let worst: { from: string; to: string; lost: number } | null = null;
  for (let i = 1; i < stages.length; i++) {
    const prev = stages[i - 1] as Point;
    const cur = stages[i] as Point;
    const lost = prev.value - cur.value;
    if (lost > 0 && (!worst || lost > worst.lost))
      worst = { from: prev.label, to: cur.label, lost };
  }
  const head = `${plural(stages.length, 'module')}; ${formatNumber(first.value)} learners completed "${first.label}".`;
  return worst
    ? `${head} The biggest drop is from "${worst.from}" to "${worst.to}" (${plural(worst.lost, 'learner')} fewer).`
    : `${head} No module has fewer completions than the one before.`;
}

/** The share of ALL learners covering each segment of a video, in words: the first and the last segment and the steepest fall. */
export function describeDropOff(
  segments: readonly { fromSecond: number; percent: number }[],
): string {
  if (segments.length === 0) return 'No segments to show.';
  const mm = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const first = segments[0] as { fromSecond: number; percent: number };
  const last = segments[segments.length - 1] as { fromSecond: number; percent: number };
  let fall: { at: number; by: number } | null = null;
  for (let i = 1; i < segments.length; i++) {
    const by =
      (segments[i - 1] as { percent: number }).percent -
      (segments[i] as { percent: number }).percent;
    if (by > 0 && (!fall || by > fall.by))
      fall = { at: (segments[i] as { fromSecond: number }).fromSecond, by };
  }
  const base = `${formatNumber(first.percent, '%')} of learners watched the start, ${formatNumber(last.percent, '%')} the end.`;
  return fall
    ? `${base} The steepest fall is at ${mm(fall.at)} (${formatNumber(fall.by, '%')} points).`
    : base;
}

/** A value in [0, max] as a step 0..steps-1 of a sequential scale (the heat strip's colour step). */
export function heatStep(value: number, max: number, steps = 5): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.min(steps - 1, Math.ceil((value / max) * (steps - 1)));
}
