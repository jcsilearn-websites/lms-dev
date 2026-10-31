import type { ItemStatus } from '@lms/backend/contracts';
import { Badge } from '../../shared/ui/layout';
import { cn } from '../../shared/utils/cn';

/** A labelled bar. `percent` null = the course has no required item yet: no bar, an honest note. */
export function ProgressBar({
  percent,
  label,
  detail,
  className,
}: {
  percent: number | null;
  /** names the bar for screen readers, e.g. "Progress in Data Structures" */
  label: string;
  /** visible text next to the number, e.g. "3 of 12 required items" */
  detail?: string | undefined;
  className?: string;
}) {
  if (percent === null) {
    return <p className={cn('text-xs text-muted-foreground', className)}>No required items yet</p>;
  }
  const value = Math.min(100, Math.max(0, percent));
  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium tabular-nums">{value}% complete</span>
        {detail && <span className="text-muted-foreground">{detail}</span>}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

const STATUS: Record<ItemStatus, { text: string; tone: 'neutral' | 'success' | 'warning' }> = {
  not_started: { text: 'Not started', tone: 'neutral' },
  in_progress: { text: 'In progress', tone: 'warning' },
  completed: { text: 'Completed', tone: 'success' },
};

/** The status in words (colour is only a hint). */
export function ItemStatusBadge({ status }: { status: ItemStatus }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.text}</Badge>;
}
