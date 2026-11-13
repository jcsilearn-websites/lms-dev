// A deliberately SIMPLE reference implementation of the gradebook calculation, in TypeScript with BigInt rationals (no
// floating point anywhere). It is written from the rules in CLAUDE.md "Gradebook", not from the SQL, and the property tests
// require the database function to agree with it EXACTLY.

export interface Q {
  n: bigint;
  d: bigint;
}
const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
};
export const q = (n: bigint | number, d: bigint | number = 1n): Q => {
  const nn = BigInt(n);
  const dd = BigInt(d);
  const g = gcd(nn, dd);
  return { n: nn / g, d: dd / g };
};
const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const div = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
export const eq = (a: Q, b: Q): boolean => a.n * b.d === b.n * a.d;

export type RoundMode = 'half_up' | 'half_even' | 'floor' | 'ceil';
export type Policy = 'exclude' | 'zero_after_due';

export interface RefItem {
  cat: number;
  /** cents */
  points: number;
  extra: boolean;
  released: boolean;
  due: 'past' | 'future' | null;
  /** cents per learner, null = no mark */
  marks: (number | null)[];
  /** cents per learner, null = no override */
  overrides: (number | null)[];
}
export interface RefCase {
  weighted: boolean;
  /** cents */
  outOf: number;
  mode: RoundMode;
  decimals: number;
  cats: { weightMilli: number; drop: number; policy: Policy }[];
  items: RefItem[];
  /** marks in cents per learner, null = none */
  finalOverride: (number | null)[];
}

/** Rounds a non-negative rational to `decimals` places by the rule; returns the exact result as a rational. */
export function roundQ(x: Q, mode: RoundMode, decimals: number): Q {
  const scale = 10n ** BigInt(decimals);
  const v = x.n * scale; // / x.d
  const fl = v / x.d;
  const rem = v - fl * x.d;
  let r: bigint;
  switch (mode) {
    case 'floor':
      r = fl;
      break;
    case 'ceil':
      r = rem > 0n ? fl + 1n : fl;
      break;
    case 'half_even':
      r = 2n * rem > x.d ? fl + 1n : 2n * rem === x.d ? fl + (fl % 2n) : fl;
      break;
    default:
      r = 2n * rem >= x.d ? fl + 1n : fl;
  }
  return q(r, scale);
}

/**
 * The final marks of learner `l`, or null when nothing counts. `learnerView` hides every item that is not released and
 * ignores the final override (what a learner is shown).
 */
export function reference(c: RefCase, l: number, learnerView = false): Q | null {
  if (!learnerView) {
    const fo = c.finalOverride[l];
    if (fo !== null && fo !== undefined) return q(fo, 100);
  }
  const catE: (bigint | null)[] = [];
  const catM: bigint[] = [];
  c.cats.forEach((cat, k) => {
    const items = c.items.map((it, index) => ({ it, index })).filter((x) => x.it.cat === k);
    const counted: { e: bigint; points: bigint; extra: boolean; index: number }[] = [];
    for (const { it, index } of items) {
      if (learnerView && !it.released) continue;
      const ov = it.overrides[l];
      const mk = it.marks[l];
      let e: bigint | null = null;
      if (ov !== null && ov !== undefined) e = BigInt(ov);
      else if (mk !== null && mk !== undefined) e = BigInt(mk);
      else if (cat.policy === 'zero_after_due' && (it.released || it.due === 'past')) e = 0n;
      if (e !== null) counted.push({ e, points: BigInt(it.points), extra: it.extra, index });
    }
    const rankable = counted
      .filter((x) => !x.extra)
      .sort((a, b) => {
        // percent ascending: e/points compared by cross multiplication, then points, then position
        const left = a.e * b.points;
        const right = b.e * a.points;
        if (left !== right) return left < right ? -1 : 1;
        if (a.points !== b.points) return a.points < b.points ? -1 : 1;
        return a.index - b.index;
      });
    const dropN = Math.max(0, Math.min(cat.drop, rankable.length - 1));
    const dropped = new Set(rankable.slice(0, dropN).map((x) => x.index));
    const kept = counted.filter((x) => !dropped.has(x.index));
    catE[k] = kept.length > 0 ? kept.reduce((s, x) => s + x.e, 0n) : null;
    catM[k] = kept.filter((x) => !x.extra).reduce((s, x) => s + x.points, 0n);
  });
  const outOf = q(c.outOf, 100);
  let marks: Q | null = null;
  if (c.weighted) {
    let total: Q = q(0);
    let w = 0n;
    c.cats.forEach((cat, k) => {
      const e = catE[k];
      const m = catM[k] as bigint;
      if (e === null || e === undefined || m <= 0n || cat.weightMilli <= 0) return;
      total = add(total, mul(q(cat.weightMilli), q(e, m)));
      w += BigInt(cat.weightMilli);
    });
    if (w > 0n) marks = mul(outOf, div(total, q(w)));
  } else {
    let e = 0n;
    let m = 0n;
    c.cats.forEach((_, k) => {
      e += catE[k] ?? 0n;
      m += catM[k] as bigint;
    });
    if (m > 0n) marks = mul(outOf, q(e, m));
  }
  return marks === null ? null : roundQ(marks, c.mode, c.decimals);
}

/** '32.50' -> the exact rational */
export function parseDecimal(s: string): Q {
  const [i, f = ''] = s.split('.');
  return q(BigInt(`${i}${f}`), 10n ** BigInt(f.length));
}
export const show = (x: Q | null): string => (x === null ? 'null' : `${x.n}/${x.d}`);
