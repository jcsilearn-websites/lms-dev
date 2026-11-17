import type { NotificationSettings, OptionalCategory } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { PageHeader } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import {
  CATEGORY_TEXT,
  getNotificationSettings,
  notificationKeys,
  updateNotificationSettings,
} from './notifications.api';

const CATEGORIES: OptionalCategory[] = [
  'learning_deadlines',
  'learning_grades',
  'learning_content',
  'teaching_grading',
  'teaching_updates',
  'admin',
];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The college's notification settings (institution admins): what members get by default, quiet hours and the digest hour (in the
 * college's time zone), and the sender name and reply-to of the college's emails. The verified sending ADDRESS is set by JCS.
 */
export function NotificationSettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: notificationKeys.settings,
    queryFn: ({ signal }) => getNotificationSettings(signal),
  });
  const [f, setF] = useState<NotificationSettings | null>(null);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (s: NotificationSettings) =>
      updateNotificationSettings({
        defaults: s.defaults,
        quietHours: s.quietHours,
        digestHour: s.digestHour,
        fromName: s.fromName?.trim() || null,
        replyTo: s.replyTo?.trim() || null,
      }),
    onSuccess: (s) => {
      qc.setQueryData(notificationKeys.settings, s);
      toast.success('Notification settings saved');
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
      <ListSkeleton rows={4} label="Loading notification settings" />
    );

  const quietBad =
    f.quietHours.enabled && (!TIME.test(f.quietHours.start) || !TIME.test(f.quietHours.end));
  const setDefault = (c: OptionalCategory, channel: 'email' | 'inApp', v: boolean) =>
    setF({ ...f, defaults: { ...f.defaults, [c]: { ...f.defaults[c], [channel]: v } } });

  return (
    <form
      className="max-w-3xl space-y-8"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!quietBad) save.mutate(f);
      }}
    >
      <PageHeader
        title="Notification settings"
        description={`What members get by default, and when. Times are in the college's time zone (${f.timeZone}).`}
        actions={
          <Link
            to={'/settings/email' as '/'}
            className="inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm font-medium hover:bg-muted sm:min-h-9"
          >
            Bouncing addresses
          </Link>
        }
      />

      <section aria-labelledby="defaults" className="space-y-2">
        <h2 id="defaults" className="text-lg font-semibold">
          Defaults for members
        </h2>
        <p className="text-sm text-muted-foreground">
          A member who has not changed a category gets these. Security emails (invitations, password
          resets and changes) are always sent.
        </p>
        <table className="w-full text-sm">
          <caption className="sr-only">Default channels per category</caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="py-2 pr-3 font-medium">
                Category
              </th>
              <th scope="col" className="w-20 px-2 py-2 text-center font-medium">
                Email
              </th>
              <th scope="col" className="w-20 px-2 py-2 text-center font-medium">
                In app
              </th>
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map((c) => (
              <tr key={c} className="border-b border-border last:border-0">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {CATEGORY_TEXT[c].label}
                </th>
                {(['email', 'inApp'] as const).map((channel) => (
                  <td key={channel} className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      className="h-6 w-6"
                      checked={f.defaults[c][channel]}
                      aria-label={`Default ${channel === 'email' ? 'email' : 'in app'}: ${CATEGORY_TEXT[c].label}`}
                      onChange={(e) => setDefault(c, channel, e.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="quiet" className="space-y-2">
        <h2 id="quiet" className="text-lg font-semibold">
          Quiet hours
        </h2>
        <p className="text-sm text-muted-foreground">
          No reminder or digest email is sent in this window (it waits until the end; a reminder
          whose deadline would pass first stays in the bell only). Security emails are never held
          back.
        </p>
        <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
          <input
            type="checkbox"
            className="size-4"
            checked={f.quietHours.enabled}
            onChange={(e) =>
              setF({ ...f, quietHours: { ...f.quietHours, enabled: e.target.checked } })
            }
          />
          Hold emails during quiet hours
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Quiet from"
            type="time"
            value={f.quietHours.start}
            disabled={!f.quietHours.enabled}
            error={
              f.quietHours.enabled && !TIME.test(f.quietHours.start)
                ? 'Use a time like 22:00'
                : undefined
            }
            onChange={(e) => setF({ ...f, quietHours: { ...f.quietHours, start: e.target.value } })}
          />
          <Field
            label="Quiet until"
            type="time"
            value={f.quietHours.end}
            disabled={!f.quietHours.enabled}
            error={
              f.quietHours.enabled && !TIME.test(f.quietHours.end)
                ? 'Use a time like 07:00'
                : undefined
            }
            onChange={(e) => setF({ ...f, quietHours: { ...f.quietHours, end: e.target.value } })}
          />
        </div>
        <Field
          label="Daily digests and Monday summaries at (hour, 0 to 23)"
          type="number"
          min={0}
          max={23}
          value={f.digestHour}
          onChange={(e) =>
            setF({
              ...f,
              digestHour: Math.min(23, Math.max(0, Math.round(Number(e.target.value) || 0))),
            })
          }
        />
      </section>

      <section aria-labelledby="sender" className="space-y-2">
        <h2 id="sender" className="text-lg font-semibold">
          Sender
        </h2>
        <p className="text-sm text-muted-foreground">
          {f.fromAddress
            ? `Emails are sent from ${f.fromAddress} (verified for your college).`
            : 'Emails are sent from the JCS iLearn address with your college name. To send from your own domain, ask JCS to verify it.'}
        </p>
        <Field
          label="Sender name (optional)"
          hint="Shown as the sender of your college's emails. Empty = the college name."
          maxLength={80}
          value={f.fromName ?? ''}
          onChange={(e) => setF({ ...f, fromName: e.target.value })}
        />
        <Field
          label="Reply-to address (optional)"
          type="email"
          hint="Where replies to the college's emails go, e.g. the office. Empty = replies are not delivered."
          value={f.replyTo ?? ''}
          onChange={(e) => setF({ ...f, replyTo: e.target.value })}
        />
      </section>

      <Button type="submit" loading={save.isPending} disabled={quietBad}>
        Save settings
      </Button>
    </form>
  );
}
