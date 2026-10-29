import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { EmptyState, ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import {
  downloadTemplate,
  type ImportKind,
  importKeys,
  listImports,
  uploadCsv,
} from './imports.api';
import { statusLabel, statusTone } from './status';

const MAX_MB = 5;

/** Step 1 of the wizard: pick the kind, get the template, upload. Below: the recent imports. */
export function ImportsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [kind, setKind] = useState<ImportKind>('students');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const abort = useRef<AbortController | null>(null);

  const recent = useQuery({
    queryKey: importKeys.list,
    queryFn: ({ signal }) => listImports(signal),
  });

  const template = useMutation({
    mutationFn: () => downloadTemplate(kind),
    onError: (err) => toast.error(describeError(err)),
  });
  const start = useMutation({
    mutationFn: () => {
      abort.current = new AbortController();
      setProgress(0);
      return uploadCsv(kind, file as File, setProgress, abort.current.signal);
    },
    onSuccess: async (imp) => {
      qc.setQueryData(importKeys.detail(imp.id), imp);
      void qc.invalidateQueries({ queryKey: importKeys.list, refetchType: 'none' });
      await navigate({ to: `/imports/${imp.id}` as '/' });
    },
    onError: (err) => {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(
        err instanceof ApiError && err.code === 'import_in_progress'
          ? 'Another import is still running. Wait for it to finish, then try again.'
          : describeError(err),
      );
    },
  });

  const pick = (f: File | null) => {
    setFileError(null);
    setFile(null);
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) return setFileError('Choose a .csv file.');
    if (f.size > MAX_MB * 1024 * 1024) return setFileError(`The file is larger than ${MAX_MB} MB.`);
    setFile(f);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bulk import"
        description="Add students or faculty from a CSV file. You review the result before anything is saved."
      />
      <Card title="1. Choose and upload">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (file) start.mutate();
          }}
        >
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Who are you importing?</legend>
            <div className="flex gap-4">
              {(['students', 'faculty'] as const).map((k) => (
                <label key={k} className="flex min-h-9 items-center gap-2 text-sm capitalize">
                  <input
                    type="radio"
                    name="kind"
                    checked={kind === k}
                    onChange={() => setKind(k)}
                  />
                  {k}
                </label>
              ))}
            </div>
          </fieldset>
          <p className="text-sm">
            Start from the template:{' '}
            <button
              type="button"
              className="text-primary underline"
              onClick={() => template.mutate()}
              disabled={template.isPending}
            >
              download the {kind} template (CSV)
            </button>
            . Up to 10,000 rows, {MAX_MB} MB.
          </p>
          <div>
            <label htmlFor="csv-file" className="mb-1 block text-sm font-medium">
              CSV file
            </label>
            <input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              aria-describedby={fileError ? 'csv-error' : undefined}
              aria-invalid={fileError ? true : undefined}
              className="block w-full text-sm"
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
            {fileError && (
              <p id="csv-error" role="alert" className="mt-1 text-sm text-danger">
                {fileError}
              </p>
            )}
          </div>
          {start.isPending && (
            <div>
              <progress
                className="h-2 w-full"
                max={1}
                value={progress}
                aria-label="Upload progress"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Checking the rows...'}
              </p>
            </div>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={!file} loading={start.isPending}>
              Upload and check
            </Button>
            {start.isPending && (
              <Button variant="secondary" onClick={() => abort.current?.abort()}>
                Stop
              </Button>
            )}
          </div>
        </form>
      </Card>

      <Card title="Recent imports">
        {recent.isPending ? (
          <ListSkeleton rows={3} label="Loading imports" />
        ) : recent.isError ? (
          <ErrorState error={recent.error} onRetry={() => void recent.refetch()} />
        ) : recent.data.items.length === 0 ? (
          <EmptyState title="No imports yet" />
        ) : (
          <ul className="divide-y divide-border">
            {recent.data.items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <Link
                  to={`/imports/${i.id}` as '/'}
                  className="min-w-0 truncate text-primary underline"
                >
                  {i.fileName}
                </Link>
                <span className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {i.kind}, {i.counts.total} rows, {new Date(i.createdAt).toLocaleString()}
                  </span>
                  <Badge tone={statusTone(i.status)}>{statusLabel(i.status)}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
