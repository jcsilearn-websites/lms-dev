import type {
  AssignmentFile,
  AssignmentMe,
  SubmitAssignmentResponse,
} from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { RichTextView } from '../../shared/richtext/RichTextView';
import { Button } from '../../shared/ui/button';
import { Dialog } from '../../shared/ui/dialog';
import { INPUT_CLASS } from '../../shared/ui/field';
import { Badge, Card } from '../../shared/ui/layout';
import { ErrorState, ListSkeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { assignmentKeys, getMe, learnerFile, submit, uploadHandInFile } from './assignments.api';
import { bytes, duration, latePolicyText, points, remainingSeconds, stamp } from './format';

// What the item page shows for an assignment. A learner: the task, THEIR due date with a countdown by the server's clock,
// the rules (late policy, the grace period for uploads), the hand-in form, every version they made (the latest counts), and
// their grade once it may be seen. Anyone else (an instructor, an assistant) gets the links to the tools.

const NOT_YET: Record<string, string> = {
  not_open: 'This assignment is not open yet.',
  closed: 'The due date and the late period are over: nothing more is accepted.',
};

const LINK =
  'inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm font-medium hover:bg-muted sm:min-h-9';

export function AssignmentItemView({ offeringId, itemId }: { offeringId: string; itemId: string }) {
  const me = useQuery({
    queryKey: assignmentKeys.me(offeringId, itemId),
    queryFn: ({ signal }) => getMe(offeringId, itemId, signal),
    retry: (n, err) => !(err instanceof ApiError && [403, 404].includes(err.status)) && n < 1,
  });
  if (me.isLoading) return <ListSkeleton rows={3} label="Loading the assignment" />;
  if (me.error instanceof ApiError && me.error.status === 403) {
    return <StaffLinks offeringId={offeringId} itemId={itemId} />;
  }
  if (me.isError || !me.data) {
    return (
      <ErrorState
        title="Could not load the assignment"
        error={me.error}
        onRetry={() => void me.refetch()}
      />
    );
  }
  return (
    <LearnerView
      offeringId={offeringId}
      itemId={itemId}
      me={me.data}
      fetchedAt={me.dataUpdatedAt}
    />
  );
}

function StaffLinks({ offeringId, itemId }: { offeringId: string; itemId: string }) {
  return (
    <Card title="Assignment">
      <p className="text-sm text-muted-foreground">
        You are not a learner here, so you do not hand this in.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link to={`/offerings/${offeringId}/items/${itemId}/assignment` as '/'} className={LINK}>
          Settings
        </Link>
        <Link
          to={`/offerings/${offeringId}/items/${itemId}/assignment/grading` as '/'}
          className={LINK}
        >
          Grading
        </Link>
      </div>
    </Card>
  );
}

/** Opens a file target: shown in a new tab when the browser can render it safely, otherwise downloaded. */
export function openTarget(t: { url: string; inline: boolean }): void {
  const a = document.createElement('a');
  a.href = t.url;
  a.rel = 'noopener';
  if (t.inline) a.target = '_blank';
  document.body.append(a);
  a.click();
  a.remove();
}

function FileLink({
  file,
  load,
}: {
  file: AssignmentFile;
  load: (fileId: string) => Promise<{ url: string; inline: boolean }>;
}) {
  const open = useMutation({
    mutationFn: () => load(file.fileId),
    onSuccess: openTarget,
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <button
      type="button"
      onClick={() => open.mutate()}
      disabled={open.isPending}
      className="min-h-11 text-left text-primary underline sm:min-h-0"
    >
      {file.name}
      {file.size != null && (
        <span className="ml-1 text-muted-foreground">({bytes(file.size)})</span>
      )}
    </button>
  );
}

/** Seconds left by the server's clock, ticking once a second (the browser's clock only measures the elapsed time). */
function useCountdown(dueAt: string | null, serverNow: string, fetchedAt: number): number | null {
  const offset = new Date(serverNow).getTime() - fetchedAt;
  const [left, setLeft] = useState(() => (dueAt ? remainingSeconds(dueAt, offset) : null));
  useEffect(() => {
    if (!dueAt) return setLeft(null);
    const tick = () => setLeft(remainingSeconds(dueAt, offset));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [dueAt, offset]);
  return left;
}

interface Picked {
  key: string;
  name: string;
  size: number;
  progress: number;
  state: 'uploading' | 'ready' | 'error';
  fileId?: string;
  error?: string;
}

function LearnerView({
  offeringId,
  itemId,
  me,
  fetchedAt,
}: {
  offeringId: string;
  itemId: string;
  me: AssignmentMe;
  fetchedAt: number;
}) {
  const qc = useQueryClient();
  const a = me.assignment;
  const left = useCountdown(a.dueAt, me.serverNow, fetchedAt);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  // the server is busy and the request is being sent again: the learner is told their time is protected
  const [busy, setBusy] = useState<{ attempt: number; delayMs: number } | null>(null);
  const retry = { onBusy: setBusy };
  const [ask, setAsk] = useState<Extract<
    SubmitAssignmentResponse,
    { result: 'confirm_late' }
  > | null>(null);
  // one key per hand-in: sending it twice (double click, retry, the confirmation) makes ONE version
  const requestKey = useRef(crypto.randomUUID());
  const input = useRef<HTMLInputElement>(null);

  // files the learner uploaded earlier and never handed in are offered again
  const drafts = me.drafts.filter(
    (d) => d.status === 'ready' && !picked.some((p) => p.fileId === d.fileId),
  );
  const [useDrafts, setUseDrafts] = useState<Set<string>>(new Set());
  const chosenIds = [
    ...picked.filter((p) => p.state === 'ready' && p.fileId).map((p) => p.fileId as string),
    ...drafts.filter((d) => useDrafts.has(d.fileId)).map((d) => d.fileId),
  ];
  const uploading = picked.some((p) => p.state === 'uploading');

  const send = useMutation({
    mutationFn: (confirmLate: boolean) =>
      submit(
        offeringId,
        itemId,
        {
          requestKey: requestKey.current,
          fileIds: chosenIds,
          ...(text.trim() ? { text: text.trim() } : {}),
          ...(link.trim() ? { link: link.trim() } : {}),
          ...(confirmLate ? { confirmLate: true } : {}),
        },
        retry,
      ),
    onSuccess: (r) => {
      if (r.result === 'confirm_late') return setAsk(r);
      setAsk(null);
      toast.success(
        r.lateSeconds > 0
          ? `Handed in as version ${r.versionNo}: ${duration(r.lateSeconds)} late, ${r.penaltyPercent}% penalty.`
          : `Handed in as version ${r.versionNo}.`,
      );
      setPicked([]);
      setText('');
      setLink('');
      setUseDrafts(new Set());
      requestKey.current = crypto.randomUUID();
      void qc.invalidateQueries({ queryKey: assignmentKeys.me(offeringId, itemId) });
    },
    onError: (err) => {
      setAsk(null);
      toast.error(describeError(err));
      // the page may have been out of date (the due date passed): read it again
      void qc.invalidateQueries({ queryKey: assignmentKeys.me(offeringId, itemId) });
    },
  });

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const room = a.maxFiles - (picked.length + useDrafts.size);
    for (const file of Array.from(files).slice(0, Math.max(0, room))) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      const update = (patch: Partial<Picked>) =>
        setPicked((all) => all.map((p) => (p.key === key ? { ...p, ...patch } : p)));
      setPicked((all) => [
        ...all,
        { key, name: file.name, size: file.size, progress: 0, state: 'uploading' },
      ]);
      void uploadHandInFile(
        offeringId,
        itemId,
        file,
        (progress) => update({ progress }),
        undefined,
        retry,
      )
        .then((f) => update({ state: 'ready', progress: 1, fileId: f.fileId }))
        .catch((err) => update({ state: 'error', error: describeError(err) }));
    }
    if (files.length > room) toast.error(`You can hand in at most ${a.maxFiles} files.`);
    if (input.current) input.current.value = '';
  };

  const nothing = chosenIds.length === 0 && !text.trim() && !link.trim();
  const late = me.state === 'late';
  const latest = me.submissions[0];

  return (
    <div className="space-y-4">
      <Card title="Assignment">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {me.state === 'open' && <Badge tone="success">Open</Badge>}
          {me.state === 'late' && <Badge tone="warning">Late: a penalty applies</Badge>}
          {me.state === 'closed' && <Badge tone="danger">Closed</Badge>}
          {me.state === 'not_open' && <Badge>Not open yet</Badge>}
          {a.hasExtension && <Badge>Your due date was extended</Badge>}
        </div>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {a.opensAt && me.state === 'not_open' && (
            <div>
              <dt className="text-muted-foreground">Opens</dt>
              <dd>{stamp(a.opensAt)}</dd>
            </div>
          )}
          <div>
            <dt className="text-muted-foreground">Due</dt>
            <dd data-testid="due">{a.dueAt ? stamp(a.dueAt) : 'No due date'}</dd>
          </div>
          {a.dueAt && left !== null && (
            <div>
              <dt className="text-muted-foreground">
                {left >= 0 ? 'Time left' : 'Past the due date by'}
              </dt>
              <dd className="font-medium tabular-nums" data-testid="countdown">
                {duration(Math.abs(left))}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-muted-foreground">Maximum</dt>
            <dd>{points(a.maxPoints)}</dd>
          </div>
          {a.passingScore != null && (
            <div>
              <dt className="text-muted-foreground">Pass mark</dt>
              <dd>{a.passingScore}%</dd>
            </div>
          )}
          <div>
            <dt className="text-muted-foreground">You can hand in</dt>
            <dd>
              {[
                a.allowFile && `files (up to ${a.maxFiles}, ${a.maxFileMb} MB each)`,
                a.allowText && 'text',
                a.allowLink && 'a link',
              ]
                .filter(Boolean)
                .join(', ')}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Resubmitting</dt>
            <dd>
              {a.resubmissionAllowed
                ? 'allowed: every version is kept, the latest one counts'
                : 'not allowed: you hand in once'}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-sm" data-testid="late-policy">
          {latePolicyText(a)}
        </p>
        {a.dueAt && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="grace-note">
            The clock of the server decides, not yours. If you START uploading a file before the due
            date and hand in within {Math.round(me.graceSeconds / 60)} minutes after it, your work
            counts as on time. If the server is busy when you press the button, the page keeps
            trying and the moment your request reached the server is what counts, not the moment it
            was finally accepted.
          </p>
        )}
        {a.instructions && (
          <div className="mt-4 border-t border-border pt-4">
            <h3 className="mb-2 text-sm font-semibold">Instructions</h3>
            <RichTextView doc={a.instructions} />
          </div>
        )}
        {a.attachments.length > 0 && (
          <div className="mt-4 border-t border-border pt-4">
            <h3 className="mb-2 text-sm font-semibold">Files from your instructor</h3>
            <ul className="space-y-1 text-sm">
              {a.attachments.map((f) => (
                <li key={f.fileId}>
                  <FileLink file={f} load={(id) => learnerFile(offeringId, itemId, id)} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {me.canSubmit ? (
        <Card title={latest ? 'Hand in a new version' : 'Hand in your work'}>
          {late && (
            <p
              role="status"
              className="mb-3 rounded-md border border-warning p-3 text-sm"
              data-testid="late-now"
            >
              You are {duration(me.lateSecondsNow)} late. Handing in now costs{' '}
              <strong>
                {me.penaltyPercentNow}% = {points(me.penaltyPointsNow)}
              </strong>{' '}
              of {points(a.maxPoints)}.
            </p>
          )}
          {me.state === 'closed' && me.draftWithinGrace && (
            <p role="status" className="mb-3 rounded-md border border-border p-3 text-sm">
              The due date has passed, but you started uploading before it: you can still hand in
              for a short time and it counts as on time.
            </p>
          )}
          {latest && (
            <p className="mb-3 text-sm text-muted-foreground">
              A new version replaces version {latest.versionNo} as the one that counts. Version{' '}
              {latest.versionNo} stays on record.
            </p>
          )}
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              send.mutate(false);
            }}
          >
            {a.allowFile && (
              <div>
                <label htmlFor="hand-in-files" className="block text-sm font-medium">
                  Files
                </label>
                <input
                  ref={input}
                  id="hand-in-files"
                  type="file"
                  multiple
                  className={`${INPUT_CLASS} py-1.5`}
                  onChange={(e) => addFiles(e.target.files)}
                  aria-describedby="hand-in-files-hint"
                />
                <p id="hand-in-files-hint" className="mt-1 text-xs text-muted-foreground">
                  Up to {a.maxFiles} files of {a.maxFileMb} MB: PDF, images, Office documents, text,
                  ZIP. Programs and scripts are not accepted.
                </p>
                {(picked.length > 0 || drafts.length > 0) && (
                  <ul className="mt-2 space-y-1 text-sm" aria-label="Files to hand in">
                    {picked.map((p) => (
                      <li key={p.key} className="flex flex-wrap items-center gap-2">
                        <span>{p.name}</span>
                        <span className="text-muted-foreground">({bytes(p.size)})</span>
                        {p.state === 'uploading' && (
                          <progress
                            value={p.progress}
                            max={1}
                            aria-label={`Uploading ${p.name}`}
                            className="h-2 w-32"
                          />
                        )}
                        {p.state === 'ready' && <Badge tone="success">Uploaded</Badge>}
                        {p.state === 'error' && (
                          <span role="alert" className="text-danger">
                            {p.error}
                          </span>
                        )}
                        {p.state !== 'uploading' && (
                          <button
                            type="button"
                            className="min-h-11 px-2 text-primary underline sm:min-h-0"
                            onClick={() => setPicked((all) => all.filter((x) => x.key !== p.key))}
                          >
                            Remove {p.name}
                          </button>
                        )}
                      </li>
                    ))}
                    {drafts.map((d) => (
                      <li key={d.fileId} className="flex items-center gap-2">
                        <input
                          id={`draft-${d.fileId}`}
                          type="checkbox"
                          className="size-5"
                          checked={useDrafts.has(d.fileId)}
                          onChange={(e) =>
                            setUseDrafts((s) => {
                              const n = new Set(s);
                              if (e.target.checked) n.add(d.fileId);
                              else n.delete(d.fileId);
                              return n;
                            })
                          }
                        />
                        <label htmlFor={`draft-${d.fileId}`}>
                          {d.name}{' '}
                          <span className="text-muted-foreground">
                            (uploaded earlier, not handed in)
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {a.allowText && (
              <div>
                <label htmlFor="hand-in-text" className="block text-sm font-medium">
                  Your text
                </label>
                <textarea
                  id="hand-in-text"
                  rows={6}
                  maxLength={50000}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  className={`${INPUT_CLASS} py-2`}
                />
              </div>
            )}
            {a.allowLink && (
              <div>
                <label htmlFor="hand-in-link" className="block text-sm font-medium">
                  A link to your work
                </label>
                <input
                  id="hand-in-link"
                  type="url"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="https://"
                  className={INPUT_CLASS}
                />
              </div>
            )}
            {busy && (
              <p
                role="status"
                className="rounded-md border border-warning p-3 text-sm"
                data-testid="busy"
              >
                Server busy — retrying, your submission time is protected. Keep this page open: your
                work and the moment you pressed the button are kept (attempt {busy.attempt}).
              </p>
            )}
            <Button type="submit" loading={send.isPending} disabled={nothing || uploading}>
              {late ? `Hand in late (${me.penaltyPercentNow}% penalty)` : 'Hand in'}
            </Button>
            {uploading && (
              <p className="text-xs text-muted-foreground">Wait for the uploads to finish.</p>
            )}
          </form>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="cannot-submit">
          {latest && !a.resubmissionAllowed
            ? 'You have handed in. This assignment accepts only one submission.'
            : (NOT_YET[me.state] ?? '')}
        </p>
      )}

      {me.grade && <GradeCard me={me} offeringId={offeringId} itemId={itemId} />}

      {me.submissions.length > 0 && (
        <Card title="Your submissions">
          <ul className="divide-y divide-border">
            {me.submissions.map((s) => (
              <li key={s.id} className="space-y-1 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Version {s.versionNo}</span>
                  <span className="text-muted-foreground">{stamp(s.submittedAt)}</span>
                  {s.versionNo === me.counts && <Badge tone="success">This one counts</Badge>}
                  {s.lateSeconds > 0 ? (
                    <Badge tone="warning">
                      Late by {duration(s.lateSeconds)}: {s.penaltyPercent}% penalty
                    </Badge>
                  ) : s.onGrace ? (
                    <Badge>On time (upload began before the due date)</Badge>
                  ) : (
                    <Badge tone="success">On time</Badge>
                  )}
                </div>
                {s.files.length > 0 && (
                  <ul className="space-y-1">
                    {s.files.map((f) => (
                      <li key={f.fileId}>
                        <FileLink file={f} load={(id) => learnerFile(offeringId, itemId, id)} />
                      </li>
                    ))}
                  </ul>
                )}
                {s.text && <p className="whitespace-pre-wrap rounded-md bg-muted p-2">{s.text}</p>}
                {s.link && (
                  <p>
                    Link:{' '}
                    <a
                      href={s.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline"
                    >
                      {s.link}
                    </a>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Dialog
        open={ask !== null}
        onClose={() => setAsk(null)}
        title="Hand in late and replace your on-time version?"
      >
        {ask && (
          <div className="space-y-3 text-sm">
            <p>
              Your version {ask.currentVersionNo} was handed in on time. The version you are about
              to hand in is <strong>{duration(ask.lateSeconds)} late</strong>.
            </p>
            <p data-testid="late-confirm-penalty">
              If it replaces version {ask.currentVersionNo} your score is reduced by{' '}
              <strong>
                {ask.penaltyPercent}% = {points(ask.penaltyPoints)}
              </strong>{' '}
              of {points(ask.maxPoints)}. Version {ask.currentVersionNo} stays on record, but the
              latest version is the one that is graded.
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={() => setAsk(null)} disabled={send.isPending}>
                Keep my on-time version
              </Button>
              <Button variant="danger" loading={send.isPending} onClick={() => send.mutate(true)}>
                Hand in late ({ask.penaltyPercent}% penalty)
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function GradeCard({
  me,
  offeringId,
  itemId,
}: {
  me: AssignmentMe;
  offeringId: string;
  itemId: string;
}) {
  const g = me.grade;
  if (!g) return null;
  const passed =
    g.passingScore == null ? null : (g.finalScore * 100) / g.maxPoints >= g.passingScore;
  return (
    <Card title="Your grade">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2" data-testid="grade">
        <div>
          <dt className="text-muted-foreground">Score before the late penalty</dt>
          <dd data-testid="grade-raw">
            {g.rawScore} / {g.maxPoints}
            {g.overridden && ' (set by your grader, not only by the rubric)'}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Late penalty</dt>
          <dd data-testid="grade-penalty">
            {g.penaltyWaived
              ? 'Waived by your instructor'
              : g.penaltyPoints > 0
                ? `− ${points(g.penaltyPoints)} (${g.penaltyPercent}%)`
                : 'None'}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Final score</dt>
          <dd className="text-lg font-semibold" data-testid="grade-final">
            {g.finalScore} / {g.maxPoints}
            {passed !== null && (
              <span className="ml-2">
                <Badge tone={passed ? 'success' : 'danger'}>
                  {passed ? 'Passed' : 'Not passed'}
                </Badge>
              </span>
            )}
          </dd>
        </div>
        {g.submissionVersionNo != null && (
          <div>
            <dt className="text-muted-foreground">Graded version</dt>
            <dd>
              Version {g.submissionVersionNo}
              {me.counts != null &&
                g.submissionVersionNo !== me.counts &&
                ' (you handed in a newer one since)'}
            </dd>
          </div>
        )}
      </dl>
      {g.rubric && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="mb-1 text-left text-sm font-semibold">Rubric</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-1 pr-3">
                  Criterion
                </th>
                <th scope="col" className="py-1 pr-3">
                  Level
                </th>
                <th scope="col" className="py-1 text-right">
                  Points
                </th>
              </tr>
            </thead>
            <tbody>
              {g.rubric.criteria.map((c) => {
                const pick = g.rubric?.selection?.[c.id];
                const level = c.levels.find((l) => l.id === pick?.levelId);
                return (
                  <tr key={c.id} className="border-b border-border align-top">
                    <th scope="row" className="py-1 pr-3 font-medium">
                      {c.title}
                    </th>
                    <td className="py-1 pr-3">
                      {level?.title ?? '—'}
                      {pick?.comment && <p className="text-muted-foreground">{pick.comment}</p>}
                    </td>
                    <td className="py-1 text-right tabular-nums">{pick?.points ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {g.feedback && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="mb-1 text-sm font-semibold">Feedback</h3>
          <RichTextView doc={g.feedback} />
        </div>
      )}
      {g.files.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="mb-1 text-sm font-semibold">Files from your grader</h3>
          <ul className="space-y-1 text-sm">
            {g.files.map((f) => (
              <li key={f.fileId}>
                <FileLink file={f} load={(id) => learnerFile(offeringId, itemId, id)} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
