import type { GradebookConfig, MarkImportSummary } from '@lms/backend/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Dialog } from '../../shared/ui/dialog';
import { toast } from '../../shared/ui/toast';
import { applyImport, stageImport } from './gradebook.api';

/** Marks from a CSV (register_number, then one column per manual item named like the item): a dry run first, then apply. */
export function ImportDialog({
  open,
  onClose,
  offeringId,
  config,
}: {
  open: boolean;
  onClose: () => void;
  offeringId: string;
  config: GradebookConfig;
}) {
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [summary, setSummary] = useState<MarkImportSummary | null>(null);
  const [skip, setSkip] = useState(false);
  const manual = config.items.filter((i) => i.source === 'manual');
  const close = () => {
    setSummary(null);
    setFileName('');
    setSkip(false);
    onClose();
  };
  const stage = useMutation({
    mutationFn: async (f: File) => stageImport(offeringId, await f.text()),
    onSuccess: setSummary,
    onError: (err) => toast.error(describeError(err)),
  });
  const apply = useMutation({
    mutationFn: () => applyImport(offeringId, (summary as MarkImportSummary).importId, skip),
    onSuccess: async (r) => {
      toast.success(
        `${r.saved} mark${r.saved === 1 ? '' : 's'} saved${r.skippedRows ? `, ${r.skippedRows} row(s) skipped` : ''}`,
      );
      await qc.invalidateQueries({ queryKey: ['gradebook', offeringId, 'grid'] });
      close();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const errorRows = summary?.errorRows ?? 0;
  return (
    <Dialog open={open} onClose={close} title="Import marks from a CSV file">
      <div className="max-h-[70vh] space-y-3 overflow-y-auto text-sm">
        <p>
          The first column is <code>register_number</code>. Every other column is named like a
          manual item:{' '}
          {manual.length === 0
            ? 'there is no manual item yet.'
            : manual.map((i) => i.title).join(', ')}
          . Empty cells leave a mark as it is.
        </p>
        <div>
          <label htmlFor="marks-file" className="block font-medium">
            CSV file
          </label>
          <input
            id="marks-file"
            ref={file}
            type="file"
            accept=".csv,text/csv"
            className="mt-1 block min-h-11 w-full text-base sm:text-sm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              setSummary(null);
              setFileName(f?.name ?? '');
              if (f) stage.mutate(f);
            }}
          />
          {stage.isPending && (
            <p role="status" className="mt-1 text-muted-foreground">
              Checking {fileName}…
            </p>
          )}
        </div>
        {summary && (
          <div role="status" className="space-y-2">
            <p>
              {summary.rows} row{summary.rows === 1 ? '' : 's'}, {summary.cells} mark
              {summary.cells === 1 ? '' : 's'}.{' '}
              <strong>
                {errorRows === 0
                  ? 'No errors: nothing has been written yet.'
                  : `${errorRows} row${errorRows === 1 ? '' : 's'} with errors. Nothing has been written yet.`}
              </strong>
            </p>
            {summary.unknownColumns.length > 0 && (
              <p role="alert" className="text-danger">
                No item is named: {summary.unknownColumns.join(', ')}
              </p>
            )}
            {summary.errors.length > 0 && (
              <div className="max-h-56 overflow-auto rounded-md border border-border">
                <table className="w-full text-left">
                  <caption className="sr-only">Rows with errors</caption>
                  <thead className="bg-muted">
                    <tr>
                      <th scope="col" className="p-2">
                        Row
                      </th>
                      <th scope="col" className="p-2">
                        Register no.
                      </th>
                      <th scope="col" className="p-2">
                        Column
                      </th>
                      <th scope="col" className="p-2">
                        Problem
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.errors.map((e) => (
                      <tr key={`${e.row}-${e.column}`} className="border-t border-border">
                        <td className="p-2 tabular-nums">{e.row}</td>
                        <td className="p-2">{e.register}</td>
                        <td className="p-2">{e.column}</td>
                        <td className="p-2">{e.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {errorRows > 0 && (
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
                Apply the rows without errors and skip the {errorRows} row
                {errorRows === 1 ? '' : 's'} with errors
              </label>
            )}
          </div>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!summary || (errorRows > 0 && !skip) || summary.cells === 0}
            loading={apply.isPending}
            onClick={() => apply.mutate()}
          >
            Apply the marks
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
