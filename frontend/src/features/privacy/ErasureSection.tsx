import type { ErasurePreview } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Badge, Card } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import {
  cancelMyErasure,
  erasureKeys,
  getErasurePreview,
  requestErasure,
} from './privacy.erasure.api';

// What is removed and what is kept, in the member's own numbers. The words are the same as docs/data-retention.md.
const ERASED: Record<string, [one: string, many: string]> = {
  sessions: ['sign-in on a device', 'sign-ins on devices'],
  notifications: ['notification', 'notifications'],
  notificationPreferences: ['notification setting', 'notification settings'],
  activityDays: ['day in your activity log', 'days in your activity log'],
  emails: ['e-mail queued or sent to you', 'e-mails queued or sent to you'],
  importRows: [
    'row of a staged import with your address',
    'rows of staged imports with your address',
  ],
  dataExports: ['data archive', 'data archives'],
  profileFields: [
    'profile (phone, register number, employee id)',
    'profiles (phone, register number, employee id)',
  ],
};
const KEPT: Record<string, [one: string, many: string]> = {
  enrolments: ['course enrolment', 'course enrolments'],
  progressRecords: ['progress record', 'progress records'],
  quizAttempts: ['quiz attempt', 'quiz attempts'],
  submissions: ['hand-in', 'hand-ins'],
  gradebookSnapshots: ['line in an approved gradebook', 'lines in approved gradebooks'],
  auditEntries: ['entry in the audit trail', 'entries in the audit trail'],
};
const line = (map: Record<string, [string, string]>, counts: Record<string, number>) =>
  Object.entries(map)
    .filter(([k]) => (counts[k] ?? 0) > 0)
    .map(([k, [one, many]]) => `${counts[k]} ${counts[k] === 1 ? one : many}`);

const when = (iso: string) => new Date(iso).toLocaleString();

function WhatIsKept({ p }: { p: ErasurePreview }) {
  const r = p.rules;
  const erased = line(ERASED, p.erased);
  const kept = line(KEPT, p.kept);
  return (
    <div className="space-y-4 text-sm">
      <div>
        <h3 className="font-semibold">What will be removed</h3>
        <p className="text-muted-foreground">
          Your name (the college will show &ldquo;Former member&rdquo; and a code instead), your
          phone number, register number and other personal profile fields, your sign-ins,
          notifications and queued e-mails, your activity log and your data archives. You will no
          longer be able to sign in to this college. Your account and any other college you belong
          to are not touched.
        </p>
        {erased.length > 0 && <p className="mt-1">In your case: {erased.join(', ')}.</p>}
      </div>
      <div>
        <h3 className="font-semibold">What is kept, and for how long</h3>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            <strong className="text-foreground">Your academic record.</strong> Hand-ins, quiz
            attempts, grades and progress stay in the college&apos;s records, shown under your code
            instead of your name. The college keeps its academic records for as long as it is
            required to; ask the college for its period.
          </li>
          <li>
            <strong className="text-foreground">Approved gradebooks.</strong> A gradebook that was
            approved is frozen: it keeps the name and register number it recorded at that time. This
            is part of the academic record and has been flagged for the college&apos;s legal counsel
            to decide how long it is kept.
          </li>
          <li>
            <strong className="text-foreground">The audit trail.</strong> The record that something
            happened (who, what, when) stays so that the college can account for its actions.
            Addresses and contact details are removed from it; nothing in it is deleted.
          </li>
          <li>
            <strong className="text-foreground">Backups.</strong> A backup of the database can hold
            your data for up to {r.backupRetentionDays} days. If a backup is ever restored, your
            erasure is carried out again automatically.
          </li>
          <li>
            <strong className="text-foreground">E-mails already delivered</strong> stay in the
            inboxes they reached. Your address on a list of addresses that bounce is kept only as an
            irreversible code.
          </li>
        </ul>
        {kept.length > 0 && <p className="mt-1">In your case this includes: {kept.join(', ')}.</p>}
      </div>
      <div>
        <h3 className="font-semibold">What happens when</h3>
        <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>You ask, entering your password again.</li>
          <li>
            Another administrator of the college approves or rejects it. If nobody decides within{' '}
            {r.requestExpiresAfterDays} days the request ends and you are told.
          </li>
          <li>
            After approval there are {r.graceDays} days in which you (or an administrator) can
            cancel. After that it is carried out and cannot be undone.
          </li>
        </ol>
      </div>
    </div>
  );
}

/** "Erase me from this college": the preview in numbers, the request with the password, and the request in progress. */
export function ErasureSection() {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const preview = useQuery({
    queryKey: erasureKeys.preview,
    queryFn: ({ signal }) => getErasurePreview(signal),
    retry: false,
  });
  const ask = useMutation({
    mutationFn: () => requestErasure({ password }),
    onSuccess: (r) => {
      setPassword('');
      setUnderstood(false);
      toast.success(
        r.alreadyInProgress
          ? 'Your earlier request is still open.'
          : 'Your request was sent. An administrator has to approve it.',
      );
      qc.setQueryData<ErasurePreview>(erasureKeys.preview, (cur) =>
        cur ? { ...cur, open: r.request } : cur,
      );
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const cancel = useMutation({
    mutationFn: cancelMyErasure,
    onSuccess: () => {
      toast.success('Your request was cancelled. Nothing was changed.');
      qc.setQueryData<ErasurePreview>(erasureKeys.preview, (cur) =>
        cur ? { ...cur, open: null } : cur,
      );
    },
    onError: (err) => {
      toast.error(describeError(err));
      void qc.invalidateQueries({ queryKey: erasureKeys.preview });
    },
  });

  return (
    <Card title="Erase me from this college">
      {preview.isPending ? (
        <ListSkeleton rows={3} label="Loading what erasing you would involve" />
      ) : preview.isError ? (
        <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
      ) : (
        <div className="space-y-5">
          <WhatIsKept p={preview.data} />
          {preview.data.open ? (
            <div className="space-y-2 rounded-md border border-border p-3" role="status">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={preview.data.open.status === 'approved' ? 'warning' : 'neutral'}>
                  {preview.data.open.status === 'approved'
                    ? 'Approved'
                    : 'Waiting for an administrator'}
                </Badge>
                <span className="text-sm font-medium">Your request is open.</span>
              </div>
              <p className="text-sm text-muted-foreground">
                {preview.data.open.status === 'approved' && preview.data.open.graceUntil
                  ? `It will be carried out on ${when(preview.data.open.graceUntil)}. You can cancel until then.`
                  : preview.data.open.expiresAt
                    ? `If nobody decides it ends on ${when(preview.data.open.expiresAt)}.`
                    : 'An administrator has to decide.'}
              </p>
              <Button
                variant="secondary"
                loading={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel my request
              </Button>
            </div>
          ) : preview.data.lastAdmin ? (
            <p className="text-sm" role="status">
              You are the only active administrator of this college, so you cannot be erased. Make
              another member an administrator first.
            </p>
          ) : (
            <form
              noValidate
              className="max-w-sm space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (password && understood) ask.mutate();
              }}
            >
              <Field
                label="Password to confirm"
                type="password"
                autoComplete="current-password"
                hint="We ask again so that nobody else can do this from an open session."
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <label className="flex min-h-11 items-start gap-2 text-sm sm:min-h-0">
                <input
                  type="checkbox"
                  className="mt-1 size-4"
                  checked={understood}
                  onChange={(e) => setUnderstood(e.target.checked)}
                />
                <span>
                  I understand what is removed and what is kept, and that after the grace period it
                  cannot be undone.
                </span>
              </label>
              <Button
                type="submit"
                variant="danger"
                loading={ask.isPending}
                disabled={!password || !understood}
              >
                Ask to be erased
              </Button>
            </form>
          )}
        </div>
      )}
    </Card>
  );
}
