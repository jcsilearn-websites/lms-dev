import type { AtRiskPage as AtRiskPageDto } from '@lms/backend/contracts';
import { type InfiniteData, useInfiniteQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Button } from '../../shared/ui/button';
import { Badge, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import {
  AT_RISK_PAGE,
  analyticsKeys,
  atRiskExportPath,
  formatCollegeTime,
  listAtRisk,
} from './analytics.api';
import { ExportButtons } from './ExportButtons';

const RULE: Record<string, string> = {
  behind: 'Behind',
  missed_deadlines: 'Missed deadlines',
  low_score: 'Low average score',
  inactive: 'Inactive',
};

/**
 * The learners the college's rules flag, with the rules that fired and the evidence. There is no score and no ranking: a person is
 * listed because of rules written down in the college settings, and every line says which. Visible to the staff of the offering only.
 */
export function AtRiskPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const q = useInfiniteQuery<
    AtRiskPageDto,
    Error,
    InfiniteData<AtRiskPageDto, string | undefined>,
    ReturnType<typeof analyticsKeys.atRisk>,
    string | undefined
  >({
    queryKey: analyticsKeys.atRisk(id),
    queryFn: ({ pageParam, signal }) => listAtRisk(id, pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const pages = q.data?.pages ?? [];
  const first = pages[0];
  const items = pages.flatMap((p) => p.items);
  const s = first?.settings;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Learners flagged by the rules"
        description="Each line shows which rule fired and why. Only the staff of this offering see this."
        actions={
          <ExportButtons
            subject="flagged learners"
            pathFor={(f) => atRiskExportPath(id, f)}
            fileBase="at-risk-learners"
          />
        }
      />
      <p className="text-sm text-muted-foreground">
        <Link to={`/offerings/${id}/dashboard` as '/'} className="text-primary underline">
          Back to the dashboard
        </Link>
        {first?.asOf && (
          <>
            {' '}
            · Data as of {formatCollegeTime(first.asOf, first.timeZone)} ({first.timeZone})
          </>
        )}
      </p>
      {s && (
        <details className="rounded-md border border-border bg-surface p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            The rules in force at this college
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              {s.behindEnabled
                ? "Behind: a required item open longer than the course's limit and not done."
                : 'Behind: off.'}
            </li>
            <li>
              {s.missedDeadlinesEnabled
                ? `Missed deadlines: ${s.missedDeadlines} or more.`
                : 'Missed deadlines: off.'}
            </li>
            <li>
              {s.lowScoreEnabled
                ? `Low score: the average of released scores is below ${s.passMarkPercent}%.`
                : 'Low score: off.'}
            </li>
            <li>
              {s.inactiveEnabled
                ? `Inactive: no activity for ${s.inactiveDays} days.`
                : 'Inactive: off.'}
            </li>
          </ul>
        </details>
      )}
      {q.isLoading ? (
        <ListSkeleton rows={5} label="Loading flagged learners" />
      ) : q.isError ? (
        <ErrorState
          title="Could not load the list"
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="No learner is flagged"
          description="Nobody matches the rules right now."
        />
      ) : (
        <>
          <p className="text-sm" role="status">
            {first?.total} {first?.total === 1 ? 'learner is' : 'learners are'} flagged.
          </p>
          <ul className="space-y-3">
            {items.map((l) => (
              <li key={l.participantId} className="rounded-md border border-border bg-surface p-4">
                <p className="font-semibold">
                  {l.displayName}{' '}
                  <span className="text-sm font-normal text-muted-foreground">{l.email}</span>
                </p>
                <ul className="mt-2 space-y-2">
                  {l.rules.map((r) => (
                    <li key={r.rule}>
                      <Badge tone="warning">{RULE[r.rule] ?? r.rule}</Badge>{' '}
                      <span className="text-sm">{r.summary}</span>
                      {r.evidence.length > 0 && (
                        <ul className="mt-1 list-disc pl-8 text-sm text-muted-foreground">
                          {r.evidence.map((e) => (
                            <li key={e}>{e}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {q.hasNextPage && (
            <Button
              variant="secondary"
              loading={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              Load more ({AT_RISK_PAGE} at a time)
            </Button>
          )}
        </>
      )}
    </div>
  );
}
