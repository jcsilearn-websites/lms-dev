import type { DataExport } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { AccountErasureSection } from './AccountErasureSection';
import { ErasureSection } from './ErasureSection';
import { dataExportLink, listDataExports, privacyKeys, requestDataExport } from './privacy.api';

const STATUS_TEXT: Record<DataExport['status'], string> = {
  queued: 'Waiting to be prepared',
  building: 'Being prepared',
  ready: 'Ready to download',
  failed: 'Could not be prepared',
  expired: 'Expired and deleted',
};
const TONE: Record<DataExport['status'], 'neutral' | 'success' | 'danger' | 'warning'> = {
  queued: 'neutral',
  building: 'neutral',
  ready: 'success',
  failed: 'danger',
  expired: 'warning',
};

const when = (iso: string) => new Date(iso).toLocaleString();
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * "My data": ask for an archive of the data this college keeps about me. The password is asked again (a stolen session alone
 * cannot take it). The archive is prepared in the background; the page refreshes while one is in progress, and the link is
 * signed and short-lived. It is deleted 7 days after it was prepared.
 */
export function MyDataPage() {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const list = useQuery({
    queryKey: privacyKeys.exports,
    queryFn: ({ signal }) => listDataExports(signal),
    // poll only while something is being prepared (and the tab is visible: TanStack's default)
    refetchInterval: (q) =>
      q.state.data?.items.some((x) => x.status === 'queued' || x.status === 'building')
        ? 4000
        : false,
  });
  const ask = useMutation({
    mutationFn: () => requestDataExport({ password }),
    onSuccess: (r) => {
      setPassword('');
      toast.success(
        r.alreadyInProgress
          ? 'Your earlier request is still being prepared.'
          : 'We are preparing your data. This page updates when it is ready.',
      );
      qc.setQueryData<{ items: DataExport[] }>(privacyKeys.exports, (cur) => ({
        items: [r.export, ...(cur?.items.filter((x) => x.id !== r.export.id) ?? [])],
      }));
      void qc.invalidateQueries({ queryKey: privacyKeys.exports });
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const download = useMutation({
    mutationFn: (id: string) => dataExportLink(id),
    onSuccess: (link) => {
      window.location.assign(link.url);
    },
    onError: (err) => {
      toast.error(describeError(err));
      void qc.invalidateQueries({ queryKey: privacyKeys.exports });
    },
  });

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="My data"
        description="Download a copy of the data this college keeps about you."
      />
      <Card title="Ask for my data">
        <p className="mb-4 text-sm text-muted-foreground">
          The archive holds your account and profile, your enrolments, progress, quiz attempts,
          hand-ins and the grades that have been released to you, in files you can open in a
          spreadsheet. It does not hold other people's data or results that have not been released.
          It is kept for 7 days and then deleted.
        </p>
        <form
          noValidate
          className="max-w-sm space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (password) ask.mutate();
          }}
        >
          <Field
            label="Your password"
            type="password"
            autoComplete="current-password"
            hint="We ask again so that nobody else can take your data from an open session."
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" loading={ask.isPending} disabled={!password}>
            Prepare my data
          </Button>
        </form>
      </Card>

      <Card title="My requests">
        {list.isPending ? (
          <ListSkeleton rows={2} label="Loading your data requests" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <EmptyState title="No requests yet" description="Your requests will be listed here." />
        ) : (
          <ul className="divide-y divide-border">
            {list.data.items.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Requested {when(x.requestedAt)}</p>
                  <p className="text-sm text-muted-foreground">
                    {x.status === 'ready' && x.expiresAt
                      ? `${x.sizeBytes ? `${size(x.sizeBytes)}, ` : ''}available until ${when(x.expiresAt)}`
                      : STATUS_TEXT[x.status]}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={TONE[x.status]}>{STATUS_TEXT[x.status]}</Badge>
                  {x.status === 'ready' && (
                    <Button
                      variant="secondary"
                      loading={download.isPending && download.variables === x.id}
                      onClick={() => download.mutate(x.id)}
                    >
                      Download
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ErasureSection />
      <AccountErasureSection />
    </div>
  );
}
