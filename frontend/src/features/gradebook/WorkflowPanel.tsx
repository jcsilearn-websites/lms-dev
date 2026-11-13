import type { ExcludedLearner, GradebookConfig, GradebookStatus } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Dialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Badge, Card } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import {
  approveGradebook,
  exportFile,
  getReview,
  gradebookKeys,
  returnGradebook,
  submitGradebook,
  unlockGradebook,
} from './gradebook.api';

import { STATUS_TEXT } from './workflowText';

const STATUS_TONE: Record<GradebookStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  submitted: 'warning',
  returned: 'danger',
  locked: 'success',
};
export const REASON_TEXT: Record<ExcludedLearner['reason'], string> = {
  removed_from_college: 'Removed from the college',
  removed_from_offering: 'Removed from this offering by an administrator',
  left_the_class: 'No longer in the class (left the section)',
};

function Excluded({ list }: { list: ExcludedLearner[] }) {
  if (list.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Every learner of the class is in the snapshot.
      </p>
    );
  return (
    <div className="overflow-auto rounded-md border border-border">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Learners who are not in the snapshot</caption>
        <thead className="bg-muted">
          <tr>
            <th scope="col" className="p-2">
              Learner
            </th>
            <th scope="col" className="p-2">
              Register no.
            </th>
            <th scope="col" className="p-2">
              Why
            </th>
            <th scope="col" className="p-2">
              Has work or marks
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((l) => (
            <tr key={l.participantId} className="border-t border-border">
              <td className="p-2">{l.name}</td>
              <td className="p-2">{l.registerNumber ?? '—'}</td>
              <td className="p-2">{REASON_TEXT[l.reason]}</td>
              <td className="p-2">{l.hasMarks ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Dlg = null | 'submit' | 'approve' | 'return' | 'unlock';

/** The approval workflow: submit, approve or return, unlock, the history, and the exports of approved versions. */
export function WorkflowPanel({
  offeringId,
  config,
  isInstructor,
  isApprover,
}: {
  offeringId: string;
  config: GradebookConfig;
  isInstructor: boolean;
  isApprover: boolean;
}) {
  const qc = useQueryClient();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [text, setText] = useState('');
  const [seen, setSeen] = useState(false);
  const [check, setCheck] = useState(false);
  const status = config.status;
  const showReview = (isApprover && status === 'submitted') || check;
  const review = useQuery({
    queryKey: gradebookKeys.review(offeringId),
    queryFn: ({ signal }) => getReview(offeringId, signal),
    enabled: showReview,
    staleTime: 0,
    gcTime: 0,
  });
  const done = async (message: string) => {
    toast.success(message);
    setDlg(null);
    setText('');
    setSeen(false);
    setCheck(false);
    await qc.invalidateQueries({ queryKey: gradebookKeys.all });
  };
  const fail = (err: unknown) => {
    // a gradebook that is not ready says what is missing
    toast.error(err instanceof ApiError ? err.message : describeError(err));
    setDlg(null);
    void qc.invalidateQueries({ queryKey: gradebookKeys.review(offeringId) });
  };
  const submit = useMutation({
    mutationFn: () => submitGradebook(offeringId),
    onSuccess: () => done('Submitted for approval'),
    onError: (e) => {
      setCheck(true);
      fail(e);
    },
  });
  const approve = useMutation({
    mutationFn: () => approveGradebook(offeringId, text.trim() || undefined),
    onSuccess: () => done('Approved: the gradebook is locked'),
    onError: fail,
  });
  const giveBack = useMutation({
    mutationFn: () => returnGradebook(offeringId, text.trim()),
    onSuccess: () => done('Returned to the instructor'),
    onError: fail,
  });
  const unlock = useMutation({
    mutationFn: () => unlockGradebook(offeringId, text.trim()),
    onSuccess: () => done('Unlocked: a new version is open'),
    onError: fail,
  });
  const excluded = review.data?.excluded ?? [];
  const lastEvent = config.events[0];

  return (
    <Card title="Approval">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={STATUS_TONE[status]}>{STATUS_TEXT[status]}</Badge>
        <span className="text-sm text-muted-foreground">Version {config.versionNo}</span>
        {config.submittedBy && status === 'submitted' && (
          <span className="text-sm text-muted-foreground">submitted by {config.submittedBy}</span>
        )}
      </div>
      {status === 'returned' && config.reviewComment && (
        <p role="status" className="mt-3 rounded-md border border-border bg-muted p-3 text-sm">
          <strong>Returned with this comment:</strong> {config.reviewComment}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {isInstructor && (status === 'draft' || status === 'returned') && (
          <>
            <Button variant="secondary" onClick={() => setCheck(true)}>
              Check what is missing
            </Button>
            <Button onClick={() => setDlg('submit')}>Submit for approval</Button>
          </>
        )}
        {isApprover && status === 'submitted' && (
          <>
            <Button
              onClick={() => setDlg('approve')}
              disabled={review.isLoading || (review.data?.problems.length ?? 0) > 0}
            >
              Approve and lock
            </Button>
            <Button variant="secondary" onClick={() => setDlg('return')}>
              Return with a comment
            </Button>
          </>
        )}
        {isApprover && status === 'locked' && (
          <Button variant="secondary" onClick={() => setDlg('unlock')}>
            Unlock (needs a reason)
          </Button>
        )}
      </div>

      {showReview && (
        <div className="mt-4 space-y-3">
          {review.isLoading && <ListSkeleton rows={3} label="Checking the gradebook" />}
          {review.isError && (
            <ErrorState error={review.error} onRetry={() => void review.refetch()} />
          )}
          {review.data && (
            <>
              {review.data.problems.length === 0 ? (
                <p role="status" className="text-sm">
                  Nothing stops this gradebook from being approved.
                </p>
              ) : (
                <div role="alert" className="rounded-md border border-danger p-3 text-sm">
                  <p className="font-medium">What is missing:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {review.data.problems.map((p) => (
                      <li key={p.code}>
                        {p.message}
                        {p.items ? ` ${p.items.join(', ')}.` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-sm tabular-nums">
                {review.data.stats.learners} learner{review.data.stats.learners === 1 ? '' : 's'},{' '}
                {review.data.stats.withFinal} with a final
                {review.data.stats.average !== null && (
                  <>
                    , average {review.data.stats.average}, lowest {review.data.stats.min}, highest{' '}
                    {review.data.stats.max}
                  </>
                )}
                {review.data.stats.failing > 0 && (
                  <>, {review.data.stats.failing} below the pass mark</>
                )}
                {review.data.stats.overridden > 0 && (
                  <>, {review.data.stats.overridden} set by hand</>
                )}
                .
              </p>
              {Object.keys(review.data.stats.grades).length > 0 && (
                <p className="text-sm text-muted-foreground">
                  Grades:{' '}
                  {Object.entries(review.data.stats.grades)
                    .map(([g, n]) => `${g} ${n}`)
                    .join(' · ')}
                </p>
              )}
              <section aria-label="Learners not in the snapshot">
                <h3 className="mb-1 font-semibold">
                  Learners who will NOT be in the snapshot ({excluded.length})
                </h3>
                <Excluded list={excluded} />
              </section>
              {review.data.selfApprovalAllowed === false && review.data.submittedBy && (
                <p className="text-xs text-muted-foreground">
                  The person who submitted a gradebook cannot approve or return it (college
                  setting).
                </p>
              )}
            </>
          )}
        </div>
      )}

      {config.lockedVersions.length > 0 && (
        <section aria-label="Approved versions" className="mt-4 space-y-3">
          <h3 className="font-semibold">Approved versions</h3>
          {config.lockedVersions.map((v) => (
            <div key={v.versionNo} className="rounded-md border border-border p-3 text-sm">
              <p className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <strong>Version {v.versionNo}</strong> · {new Date(v.lockedAt).toLocaleString()} ·{' '}
                  {v.learnerCount} learners
                  {v.approvedBy ? ` · approved by ${v.approvedBy}` : ''}
                  {v.selfApproved ? ' (self-approved)' : ''}
                </span>
                <span className="flex gap-2">
                  <Button
                    variant="secondary"
                    aria-label={`Download version ${v.versionNo} as CSV`}
                    onClick={() =>
                      void exportFile(offeringId, 'csv', v.versionNo).catch((e) =>
                        toast.error(describeError(e)),
                      )
                    }
                  >
                    CSV
                  </Button>
                  <Button
                    variant="secondary"
                    aria-label={`Download version ${v.versionNo} as Excel`}
                    onClick={() =>
                      void exportFile(offeringId, 'xlsx', v.versionNo).catch((e) =>
                        toast.error(describeError(e)),
                      )
                    }
                  >
                    Excel
                  </Button>
                </span>
              </p>
              {v.excluded.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer">
                    {v.excluded.length} learner{v.excluded.length === 1 ? '' : 's'} not in this
                    snapshot
                  </summary>
                  <div className="mt-2">
                    <Excluded list={v.excluded} />
                  </div>
                </details>
              )}
            </div>
          ))}
        </section>
      )}

      {lastEvent && (
        <p className="mt-3 text-xs text-muted-foreground">
          Last step: {lastEvent.action} by {lastEvent.by ?? 'someone'} on{' '}
          {new Date(lastEvent.at).toLocaleString()}
          {lastEvent.comment ? `: “${lastEvent.comment}”` : ''}
        </p>
      )}

      <Dialog
        open={dlg === 'submit'}
        onClose={() => setDlg(null)}
        title="Submit this gradebook for approval?"
      >
        <p className="text-sm text-muted-foreground">
          Marks, weights and settings cannot change while it waits. An administrator approves it
          (and it is locked) or returns it to you with a comment.
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => setDlg(null)}>
            Cancel
          </Button>
          <Button loading={submit.isPending} onClick={() => submit.mutate()}>
            Submit for approval
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={dlg === 'approve'}
        onClose={() => setDlg(null)}
        title="Approve and lock this gradebook?"
      >
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            An immutable snapshot of every learner's items, final marks and grade is taken now.
            Later changes to scores or settings never alter it.
          </p>
          {excluded.length > 0 ? (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={seen}
                onChange={(e) => setSeen(e.target.checked)}
              />
              <span>
                I have seen the {excluded.length} learner{excluded.length === 1 ? '' : 's'} who will
                not be in the snapshot.
              </span>
            </label>
          ) : null}
          <Field
            label="Comment (optional)"
            value={text}
            maxLength={1000}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => setDlg(null)}>
            Cancel
          </Button>
          <Button
            disabled={excluded.length > 0 && !seen}
            loading={approve.isPending}
            onClick={() => approve.mutate()}
          >
            Approve and lock
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={dlg === 'return'}
        onClose={() => setDlg(null)}
        title="Return this gradebook to the instructor?"
      >
        <Field
          label="What has to change (required)"
          value={text}
          maxLength={1000}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => setDlg(null)}>
            Cancel
          </Button>
          <Button
            disabled={text.trim().length < 3}
            loading={giveBack.isPending}
            onClick={() => giveBack.mutate()}
          >
            Return
          </Button>
        </div>
      </Dialog>
      <Dialog open={dlg === 'unlock'} onClose={() => setDlg(null)} title="Unlock this gradebook?">
        <p className="text-sm text-muted-foreground">
          A new version opens as a draft. The approved snapshot stays exactly as it is and is kept
          in the history. The reason is written to the audit log.
        </p>
        <Field
          label="Reason (required)"
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => setDlg(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={text.trim().length < 3}
            loading={unlock.isPending}
            onClick={() => unlock.mutate()}
          >
            Unlock version {config.versionNo + 1}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
