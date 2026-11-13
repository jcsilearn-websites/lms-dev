import type { CellState, ExplainItem, Explanation } from '@lms/backend/contracts';
import { Badge } from '../../shared/ui/layout';

// "How was this calculated?" for ONE learner: each category, what counted, what was dropped, the weights and the rounding.
// Used by the instructor's side panel and by the learner's page (the learner's explanation lists released items only).

export const STATE_TEXT: Record<CellState, string> = {
  s: 'Marked',
  o: 'Adjusted by the instructor',
  z: 'Counted as 0: no mark and past its due date',
  x: 'Not counted yet: no mark',
  p: 'Handed in, waiting to be graded',
  h: 'Not released',
};

const num = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined ? '—' : Number(v.toFixed(digits)).toString();

const ROUND_TEXT = {
  half_up: 'half up',
  half_even: 'half to even',
  floor: 'down',
  ceil: 'up',
} as const;

export function itemLine(i: ExplainItem): string {
  if (i.dropped) return `Dropped (one of the lowest): ${num(i.earned)} / ${num(i.points)}`;
  if (i.state === 's' || i.state === 'o' || i.state === 'z') {
    return `${num(i.earned)} / ${num(i.points)}${i.extra ? ' (extra credit)' : ''}`;
  }
  return STATE_TEXT[i.state];
}

export function ExplanationView({
  explanation: x,
  provisional,
}: {
  explanation: Explanation;
  /** the figures are not final yet: said in words, not only by colour */
  provisional: boolean;
}) {
  const roundText = ROUND_TEXT[x.rounding.mode];
  return (
    <div className="space-y-4" data-testid="explanation">
      <div>
        <p className="text-sm text-muted-foreground">
          {x.weighted
            ? 'Each category counts by its weight; inside a category the points of the items that count are added.'
            : 'The points of all items that count are added together.'}
        </p>
      </div>

      {x.categories.map((c) => (
        <section key={c.id} aria-label={c.name} className="rounded-md border border-border p-3">
          <h3 className="flex flex-wrap items-baseline justify-between gap-2 font-semibold">
            <span>
              {c.name}
              {x.weighted && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  weight {num(c.weight, 3)}
                </span>
              )}
            </span>
            <span className="text-sm font-normal tabular-nums">
              {c.counts
                ? `${num(c.earned)} / ${num(c.max)} = ${num(c.percent)} %`
                : 'Nothing counts here yet'}
            </span>
          </h3>
          {c.dropLowest > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              The {c.dropLowest === 1 ? 'lowest item is' : `${c.dropLowest} lowest items are`}{' '}
              dropped (never the last one).
            </p>
          )}
          {c.missingPolicy === 'zero_after_due' && (
            <p className="mt-1 text-xs text-muted-foreground">
              Work that is missing after its due date counts as 0.
            </p>
          )}
          <ul className="mt-2 divide-y divide-border text-sm">
            {c.items.map((i) => (
              <li key={i.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                <span className={i.dropped ? 'text-muted-foreground line-through' : undefined}>
                  {i.title}
                </span>
                <span className="tabular-nums">{itemLine(i)}</span>
              </li>
            ))}
            {c.items.length === 0 && (
              <li className="py-1.5 text-muted-foreground">No items yet.</li>
            )}
          </ul>
        </section>
      ))}

      <section aria-label="The final" className="rounded-md bg-muted p-3 text-sm">
        <p className="flex flex-wrap items-center gap-2 font-semibold">
          {provisional ? 'Provisional total' : 'Final total'}
          {provisional && <Badge tone="warning">Provisional</Badge>}
        </p>
        {x.final === null ? (
          <p className="mt-1">There is nothing to calculate yet.</p>
        ) : (
          <>
            {x.weightTotal !== null && x.weighted && (
              <p className="mt-1">
                Weights of the categories that count add up to {num(x.weightTotal, 3)}.
              </p>
            )}
            {x.unrounded !== null && !x.overridden && (
              <p className="mt-1 tabular-nums">
                Before rounding: {x.unrounded} out of {num(x.outOf)}. Rounded {roundText} to{' '}
                {x.rounding.decimals} decimal{x.rounding.decimals === 1 ? '' : 's'}.
              </p>
            )}
            {x.overridden && <p className="mt-1">The final was set by the instructor.</p>}
            <p className="mt-2 text-lg font-semibold tabular-nums">
              {num(x.final, x.rounding.decimals === 0 ? 2 : x.rounding.decimals)} out of{' '}
              {num(x.outOf)}
              {x.percent !== null && (
                <span className="ml-2 text-sm font-normal">({num(x.percent)} %)</span>
              )}
              {x.grade && <span className="ml-3">Grade {x.grade}</span>}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
