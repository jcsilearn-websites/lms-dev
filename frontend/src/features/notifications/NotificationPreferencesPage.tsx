import type { Preference } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Card, PageHeader } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import {
  CATEGORY_TEXT,
  getPreferences,
  notificationKeys,
  updatePreference,
} from './notifications.api';

/**
 * My notification preferences: per category, email and in-app. Security emails are mandatory. A change is saved at once and
 * applies at once (also to emails already queued: they are checked again when they are sent).
 */
export function NotificationPreferencesPage() {
  const qc = useQueryClient();
  const prefs = useQuery({
    queryKey: notificationKeys.prefs,
    queryFn: ({ signal }) => getPreferences(signal),
  });
  // What the member just chose, until the server has answered. It lives in COMPONENT state, not in the query cache: a controlled
  // checkbox must show the new value in the same synchronous flush as the click (the cache notifies subscribers a tick later, so
  // the box would spring back for a moment, and a screen reader would read the old state). On success the server's answer is the
  // truth, on failure the entry is dropped and the box returns to the stored value.
  const [pending, setPending] = useState<
    Partial<Record<string, { email: boolean; inApp: boolean }>>
  >({});
  const save = useMutation({
    mutationFn: updatePreference,
    onSuccess: (data, v) => {
      qc.setQueryData(notificationKeys.prefs, data);
      toast.success(`Saved: ${CATEGORY_TEXT[v.category].label}`);
    },
    onError: (err) => toast.error(describeError(err)),
  });

  const shown = (p: Preference, channel: 'email' | 'inApp') =>
    pending[p.category]?.[channel] ?? p[channel];
  const change = (p: Preference, channel: 'email' | 'inApp', value: boolean) => {
    const next = {
      email: channel === 'email' ? value : shown(p, 'email'),
      inApp: channel === 'inApp' ? value : shown(p, 'inApp'),
    };
    setPending((cur) => ({ ...cur, [p.category]: next }));
    save.mutate(
      { category: p.category, ...next },
      {
        onSettled: () =>
          setPending((cur) => {
            const { [p.category]: _done, ...rest } = cur;
            return rest;
          }),
      },
    );
  };

  return (
    <div>
      <PageHeader
        title="Notification settings"
        description="Choose what reaches you by email and in the bell. Changes apply immediately."
      />
      <Card>
        {prefs.isPending ? (
          <ListSkeleton rows={7} label="Loading your notification settings" />
        ) : prefs.isError ? (
          <ErrorState error={prefs.error} onRetry={() => void prefs.refetch()} />
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Notification settings per category</caption>
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
              {prefs.data.items.map((p) => {
                const text = CATEGORY_TEXT[p.category];
                const id = `pref-${p.category}`;
                return (
                  <tr key={p.category} className="border-b border-border last:border-0">
                    <th scope="row" className="py-3 pr-3 text-left font-normal">
                      <span id={`${id}-label`} className="block font-medium">
                        {text.label}
                      </span>
                      <span id={`${id}-desc`} className="block text-muted-foreground">
                        {text.description}
                        {!p.mandatory && p.overridden && ' (changed from your college’s default)'}
                      </span>
                    </th>
                    {(['email', 'inApp'] as const).map((channel) => (
                      <td key={channel} className="px-2 py-3 text-center">
                        <input
                          type="checkbox"
                          className="h-6 w-6 disabled:opacity-60"
                          checked={shown(p, channel)}
                          disabled={p.mandatory}
                          aria-label={`${channel === 'email' ? 'Email' : 'In app'}: ${text.label}`}
                          aria-describedby={`${id}-desc`}
                          onChange={(e) => change(p, channel, e.target.checked)}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <p className="mt-4 text-sm text-muted-foreground">
        Every non-security email also has a one-click “unsubscribe” link for its category. Reminders
        and digests are not emailed during your college’s quiet hours; they still appear in the
        bell.
      </p>
    </div>
  );
}
