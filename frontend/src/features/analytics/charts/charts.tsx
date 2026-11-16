import { formatNumber, heatStep, niceMax, type Point, scale, ticks } from './chartMath';

// The small SVG charts. Colours only through the design tokens (currentColor / fill-primary ...), so light, dark and the college
// colour work and the contrast of every pair is the one already tested. Text inside an SVG is for sighted users; the figure's
// summary and table (ChartFrame) are what assistive technology reads, so the SVG itself is role="img" with a short label.

const W = 640;
const H = 220;
const M = { l: 44, r: 12, t: 12, b: 30 };

function Axis({ top, unit }: { top: number; unit: string }) {
  return (
    <g className="text-muted-foreground">
      {ticks(top).map((t) => {
        const y = M.t + (H - M.t - M.b) - scale(t, top, H - M.t - M.b);
        return (
          <g key={t}>
            <line x1={M.l} x2={W - M.r} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.25} />
            <text x={M.l - 6} y={y + 4} textAnchor="end" fontSize="11" fill="currentColor">
              {formatNumber(t, unit === '%' ? '' : '')}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Vertical bars, one per point. */
export function BarChart({
  data,
  unit = '',
  label,
}: {
  data: readonly Point[];
  unit?: string;
  label: string;
}) {
  const top = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const plotW = W - M.l - M.r;
  const slot = data.length ? plotW / data.length : plotW;
  const bar = Math.max(2, slot * 0.7);
  const every = Math.max(1, Math.ceil(data.length / 8));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full">
      <Axis top={top} unit={unit} />
      {data.map((d, i) => {
        const h = scale(d.value, top, H - M.t - M.b);
        const x = M.l + i * slot + (slot - bar) / 2;
        return (
          <g key={d.label}>
            <rect x={x} y={H - M.b - h} width={bar} height={h} rx={2} className="fill-primary" />
            {i % every === 0 && (
              <text
                x={x + bar / 2}
                y={H - 10}
                textAnchor="middle"
                fontSize="11"
                className="fill-muted-foreground"
              >
                {d.label.length > 12 ? `${d.label.slice(0, 11)}…` : d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** One line over ordered points (a day series). */
export function LineChart({
  data,
  unit = '',
  label,
}: {
  data: readonly Point[];
  unit?: string;
  label: string;
}) {
  const top = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const plotW = W - M.l - M.r;
  const step = data.length > 1 ? plotW / (data.length - 1) : 0;
  const xy = data.map(
    (d, i) => [M.l + i * step, H - M.b - scale(d.value, top, H - M.t - M.b)] as const,
  );
  const path = xy
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const every = Math.max(1, Math.ceil(data.length / 6));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full">
      <Axis top={top} unit={unit} />
      {path && (
        <path
          d={path}
          fill="none"
          strokeWidth={2}
          strokeLinejoin="round"
          className="stroke-primary"
        />
      )}
      {xy.map(([x, y], i) => (
        <g key={data[i]?.label}>
          {(data.length <= 31 || i === xy.length - 1) && (
            <circle cx={x} cy={y} r={2.5} className="fill-primary" />
          )}
          {i % every === 0 && (
            <text
              x={x}
              y={H - 10}
              textAnchor="middle"
              fontSize="11"
              className="fill-muted-foreground"
            >
              {data[i]?.label.slice(5) ?? ''}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/** Horizontal funnel: one bar per stage, widths relative to the first stage. */
export function FunnelChart({ stages, label }: { stages: readonly Point[]; label: string }) {
  const top = Math.max(1, ...stages.map((s) => s.value));
  const row = 30;
  const h = stages.length * row + 4;
  return (
    <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label={label} className="h-auto w-full">
      {stages.map((s, i) => {
        const w = scale(s.value, top, W - 220);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: labels can repeat (two modules with one title); the list is static
          <g key={`${s.label}-${i}`}>
            <text x={0} y={i * row + 19} fontSize="12" className="fill-foreground">
              {s.label.length > 24 ? `${s.label.slice(0, 23)}…` : s.label}
            </text>
            <rect
              x={160}
              y={i * row + 4}
              width={Math.max(2, w)}
              height={row - 10}
              rx={2}
              className="fill-primary"
            />
            <text
              x={160 + Math.max(2, w) + 6}
              y={i * row + 19}
              fontSize="12"
              className="fill-muted-foreground"
            >
              {formatNumber(s.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const STEPS = [0.08, 0.28, 0.5, 0.74, 1];

/** A strip of equal cells, the colour step is the value (video drop-off, a week of activity). */
export function HeatStrip({
  cells,
  max,
  label,
  unit = '',
}: {
  cells: readonly Point[];
  max?: number;
  label: string;
  unit?: string;
}) {
  const top = max ?? Math.max(0, ...cells.map((c) => c.value));
  return (
    <svg viewBox={`0 0 ${W} 56`} role="img" aria-label={label} className="h-auto w-full">
      {cells.map((c, i) => {
        const w = W / Math.max(1, cells.length);
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: labels can repeat; the cells are static
            key={`${c.label}-${i}`}
            x={i * w}
            y={4}
            width={Math.max(1, w - 1)}
            height={36}
            className="fill-primary"
            fillOpacity={STEPS[heatStep(c.value, top)]}
          >
            <title>{`${c.label}: ${formatNumber(c.value, unit)}`}</title>
          </rect>
        );
      })}
      <text x={0} y={54} fontSize="11" className="fill-muted-foreground">
        {cells[0]?.label ?? ''}
      </text>
      <text x={W} y={54} fontSize="11" textAnchor="end" className="fill-muted-foreground">
        {cells.at(-1)?.label ?? ''}
      </text>
    </svg>
  );
}
