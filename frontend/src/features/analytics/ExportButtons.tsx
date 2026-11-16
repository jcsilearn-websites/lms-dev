import { useMutation } from '@tanstack/react-query';
import { downloadFile } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { toast } from '../../shared/ui/toast';

/** CSV and XLSX download buttons for one table: each is a labelled button that is busy while the file is made. */
export function ExportButtons({
  subject,
  pathFor,
  fileBase,
}: {
  /** what is exported, in words: the buttons say "Export <subject> as CSV" to a screen reader */
  subject: string;
  pathFor: (format: 'csv' | 'xlsx') => string;
  fileBase: string;
}) {
  const run = useMutation({
    mutationFn: (format: 'csv' | 'xlsx') => downloadFile(pathFor(format), `${fileBase}.${format}`),
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <div className="flex flex-wrap gap-2">
      {(['csv', 'xlsx'] as const).map((f) => (
        <Button
          key={f}
          variant="secondary"
          loading={run.isPending && run.variables === f}
          aria-label={`Export ${subject} as ${f.toUpperCase()}`}
          onClick={() => run.mutate(f)}
        >
          {f.toUpperCase()}
        </Button>
      ))}
    </div>
  );
}
