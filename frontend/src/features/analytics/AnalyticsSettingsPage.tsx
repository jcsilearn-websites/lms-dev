import type { AnalyticsSettings } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { PageHeader } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { analyticsKeys, getAnalyticsSettings, updateAnalyticsSettings } from './analytics.api';

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4"
      />
      {label}
    </label>
  );
}

/** College time zone, the at-risk rules (the thresholds are the college's), course health and the billing definition. */
export function AnalyticsSettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: analyticsKeys.settings,
    queryFn: ({ signal }) => getAnalyticsSettings(signal),
  });
  const [f, setF] = useState<AnalyticsSettings | null>(null);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (s: AnalyticsSettings) =>
      updateAnalyticsSettings({
        timeZone: s.timeZone,
        atRisk: s.atRisk,
        showCourseHealth: s.showCourseHealth,
        courseHealthWeeks: s.courseHealthWeeks,
        courseHealthBacklogDays: s.courseHealthBacklogDays,
        usageMinActiveDays: s.usageMinActiveDays,
        usageLearnersOnly: s.usageLearnersOnly,
      }),
    onSuccess: (s) => {
      qc.setQueryData(analyticsKeys.settings, s);
      void qc.invalidateQueries({ queryKey: ['analytics'] });
      toast.success('Settings saved');
    },
    onError: (err) => toast.error(describeError(err)),
  });
  if (q.isLoading || !f)
    return q.isError ? (
      <ErrorState
        title="Could not load the settings"
        error={q.error}
        onRetry={() => void q.refetch()}
      />
    ) : (
      <ListSkeleton rows={4} label="Loading settings" />
    );
  const r = f.atRisk;
  const setRisk = (patch: Partial<AnalyticsSettings['atRisk']>) =>
    setF({ ...f, atRisk: { ...r, ...patch } });
  const num = (v: string, min: number, max: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  return (
    <form
      className="max-w-2xl space-y-8"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate(f);
      }}
    >
      <PageHeader
        title="Analytics settings"
        description="Time zone, who is flagged and why, course health, and how billable learners are counted."
      />
      <section aria-labelledby="tz" className="space-y-2">
        <h2 id="tz" className="text-lg font-semibold">
          Time zone
        </h2>
        <Field
          label="College time zone (IANA name)"
          hint="Every day, week and month, and every date shown, uses this zone. Example: Asia/Kolkata. A change applies from now on; past days keep their day."
          value={f.timeZone}
          onChange={(e) => setF({ ...f, timeZone: e.target.value })}
        />
      </section>
      <section aria-labelledby="risk" className="space-y-2">
        <h2 id="risk" className="text-lg font-semibold">
          Learners flagged by the rules
        </h2>
        <p className="text-sm text-muted-foreground">
          There is no score: a learner is listed with the rules that fired. Changes apply at once to
          every list.
        </p>
        <Check
          label="Behind on required items (uses each offering's own days setting)"
          checked={r.behindEnabled}
          onChange={(v) => setRisk({ behindEnabled: v })}
        />
        <Check
          label="Missed deadlines"
          checked={r.missedDeadlinesEnabled}
          onChange={(v) => setRisk({ missedDeadlinesEnabled: v })}
        />
        <Field
          label="Flag at this many missed deadlines"
          type="number"
          min={1}
          max={20}
          value={r.missedDeadlines}
          onChange={(e) =>
            setRisk({ missedDeadlines: num(e.target.value, 1, 20, r.missedDeadlines) })
          }
        />
        <Check
          label="Average of released scores below the pass mark"
          checked={r.lowScoreEnabled}
          onChange={(v) => setRisk({ lowScoreEnabled: v })}
        />
        <Field
          label="Pass mark (%)"
          type="number"
          min={1}
          max={100}
          value={r.passMarkPercent}
          onChange={(e) =>
            setRisk({ passMarkPercent: num(e.target.value, 1, 100, r.passMarkPercent) })
          }
        />
        <Check
          label="No activity for a number of days"
          checked={r.inactiveEnabled}
          onChange={(v) => setRisk({ inactiveEnabled: v })}
        />
        <Field
          label="Days without activity"
          type="number"
          min={1}
          max={120}
          value={r.inactiveDays}
          onChange={(e) => setRisk({ inactiveDays: num(e.target.value, 1, 120, r.inactiveDays) })}
        />
      </section>
      <section aria-labelledby="health" className="space-y-2">
        <h2 id="health" className="text-lg font-semibold">
          Needs attention (course health)
        </h2>
        <p className="text-sm text-muted-foreground">
          A list, for institution administrators only, of running courses whose content has not
          changed or whose grading is waiting. It is about the upkeep of a course, not about any
          person, and other instructors never see it.
        </p>
        <Check
          label="Show the Needs attention list to institution administrators"
          checked={f.showCourseHealth}
          onChange={(v) => setF({ ...f, showCourseHealth: v })}
        />
        <Field
          label="Weeks without new content before a course is listed"
          type="number"
          min={1}
          max={26}
          value={f.courseHealthWeeks}
          onChange={(e) =>
            setF({ ...f, courseHealthWeeks: num(e.target.value, 1, 26, f.courseHealthWeeks) })
          }
        />
        <Field
          label="Days the oldest ungraded work may wait before a course is listed"
          type="number"
          min={1}
          max={90}
          value={f.courseHealthBacklogDays}
          onChange={(e) =>
            setF({
              ...f,
              courseHealthBacklogDays: num(e.target.value, 1, 90, f.courseHealthBacklogDays),
            })
          }
        />
      </section>
      <section aria-labelledby="billing" className="space-y-2">
        <h2 id="billing" className="text-lg font-semibold">
          Billable learners
        </h2>
        <Field
          label="Active on at least this many days of the month"
          type="number"
          min={1}
          max={31}
          value={f.usageMinActiveDays}
          onChange={(e) =>
            setF({ ...f, usageMinActiveDays: num(e.target.value, 1, 31, f.usageMinActiveDays) })
          }
        />
        <Check
          label="Count only learners (not instructors or staff)"
          checked={f.usageLearnersOnly}
          onChange={(v) => setF({ ...f, usageLearnersOnly: v })}
        />
      </section>
      <Button type="submit" loading={save.isPending}>
        Save settings
      </Button>
    </form>
  );
}
