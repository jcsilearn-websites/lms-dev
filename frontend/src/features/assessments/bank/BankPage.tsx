import type { QuestionDto, QuestionImportDto, QuestionPage } from '@lms/backend/contracts';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { describeError } from '../../../shared/api/errors';
import { plainText, RichTextView } from '../../../shared/richtext/RichTextView';
import { Button } from '../../../shared/ui/button';
import { Dialog } from '../../../shared/ui/dialog';
import { Badge, PageHeader } from '../../../shared/ui/layout';
import { Select } from '../../../shared/ui/select';
import { EmptyState, ErrorState, ListSkeleton } from '../../../shared/ui/states';
import { toast } from '../../../shared/ui/toast';
import {
  assessmentKeys,
  cancelImport,
  confirmImport,
  downloadQuestionTemplate,
  getQuestion,
  importRows,
  listQuestions,
  listTags,
  listVersions,
  type QuestionFilters,
  setQuestionArchived,
  uploadQuestionImport,
} from '../assessments.api';
import { TYPE_LABEL } from '../labels';
import { QuestionDialog } from './QuestionDialog';

// The question bank of a COURSE: shared by every offering of it. Instructors (of any offering) manage, assistants and
// administrators read. Lists are keyset "load more"; a change patches the cached pages instead of refetching them.

type Pages = InfiniteData<QuestionPage, string | undefined>;

export function BankPage() {
  const { courseId } = useParams({ strict: false }) as { courseId: string };
  const qc = useQueryClient();
  const [filters, setFilters] = useState<QuestionFilters>({});
  const [dialog, setDialog] = useState<
    | { type: 'edit'; question?: QuestionDto }
    | { type: 'versions'; question: QuestionDto }
    | { type: 'import' }
    | null
  >(null);
  const list = useInfiniteQuery({
    queryKey: assessmentKeys.questionList(courseId, filters),
    queryFn: ({ pageParam, signal }) => listQuestions(courseId, filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: QuestionPage) => last.nextCursor ?? undefined,
  });
  const tags = useQuery({
    queryKey: assessmentKeys.tags(courseId),
    queryFn: ({ signal }) => listTags(courseId, signal),
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  const patchLists = (fn: (items: QuestionDto[]) => QuestionDto[]) =>
    qc.setQueriesData<Pages>(
      { queryKey: [...assessmentKeys.questions(courseId), 'list'] },
      (old) =>
        old ? { ...old, pages: old.pages.map((p) => ({ ...p, items: fn(p.items) })) } : old,
    );
  const refreshLists = () => {
    void qc.invalidateQueries({ queryKey: [...assessmentKeys.questions(courseId), 'list'] });
    void qc.invalidateQueries({ queryKey: assessmentKeys.tags(courseId) });
  };
  const archive = useMutation({
    mutationFn: (q: QuestionDto) => setQuestionArchived(courseId, q.id, q.status === 'active'),
    onSuccess: (saved) => {
      // it leaves the list it was in (active <-> archived)
      patchLists((xs) => xs.filter((x) => x.id !== saved.id));
      toast.success(saved.status === 'archived' ? 'Question archived.' : 'Question restored.');
    },
    onError: (err) => toast.error(describeError(err)),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Question bank"
        description="Questions of this course, shared by all its offerings. Editing a question saves a new version: past attempts keep what they showed."
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog({ type: 'import' })}>
              Import from CSV
            </Button>
            <Button onClick={() => setDialog({ type: 'edit' })}>New question</Button>
          </>
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Type"
          value={filters.type ?? ''}
          onChange={(e) => setFilters({ ...filters, type: e.target.value || undefined })}
        >
          <option value="">All types</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select
          label="Difficulty"
          value={filters.difficulty ?? ''}
          onChange={(e) => setFilters({ ...filters, difficulty: e.target.value || undefined })}
        >
          <option value="">Any</option>
          <option value="easy">Easy</option>
          <option value="medium">Medium</option>
          <option value="hard">Hard</option>
        </Select>
        <Select
          label="Tag"
          value={filters.tag ?? ''}
          onChange={(e) => setFilters({ ...filters, tag: e.target.value || undefined })}
        >
          <option value="">Any tag</option>
          {tags.data?.items.map((t) => (
            <option key={t.tag} value={t.tag}>
              {t.tag} ({t.count})
            </option>
          ))}
        </Select>
        <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
          <input
            type="checkbox"
            className="size-5"
            checked={filters.archived === true}
            onChange={(e) => setFilters({ ...filters, archived: e.target.checked || undefined })}
          />
          Archived questions
        </label>
      </div>

      {list.isLoading ? (
        <ListSkeleton rows={5} label="Loading questions" />
      ) : list.isError ? (
        <ErrorState
          title="Could not load the question bank"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={filters.archived ? 'No archived questions' : 'No questions yet'}
          description="Add questions one by one, or import many from a CSV file."
          action={<Button onClick={() => setDialog({ type: 'edit' })}>New question</Button>}
        />
      ) : (
        <ul className="space-y-3">
          {items.map((q) => (
            <li key={q.id} className="space-y-2 rounded-md border border-border bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{TYPE_LABEL[q.type]}</Badge>
                <Badge
                  tone={
                    q.difficulty === 'hard'
                      ? 'danger'
                      : q.difficulty === 'easy'
                        ? 'success'
                        : 'warning'
                  }
                >
                  {q.difficulty}
                </Badge>
                <span className="text-xs text-muted-foreground">v{q.version}</span>
                {q.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
              <div className="line-clamp-3 text-sm">
                <RichTextView doc={q.stem} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setDialog({ type: 'edit', question: q })}
                >
                  Edit
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setDialog({ type: 'versions', question: q })}
                >
                  Versions
                </Button>
                <Button
                  variant="secondary"
                  loading={archive.isPending && archive.variables?.id === q.id}
                  onClick={() => archive.mutate(q)}
                >
                  {q.status === 'active' ? 'Archive' : 'Restore'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            loading={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      )}

      {dialog?.type === 'edit' && (
        <QuestionDialog
          courseId={courseId}
          question={dialog.question}
          onClose={() => setDialog(null)}
          onSaved={(saved, created) => {
            setDialog(null);
            if (created) refreshLists();
            else patchLists((xs) => xs.map((x) => (x.id === saved.id ? saved : x)));
            qc.setQueryData(assessmentKeys.question(courseId, saved.id), saved);
          }}
        />
      )}
      {dialog?.type === 'versions' && (
        <VersionsDialog
          courseId={courseId}
          question={dialog.question}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'import' && (
        <ImportDialog
          courseId={courseId}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            refreshLists();
          }}
        />
      )}
    </div>
  );
}

function VersionsDialog({
  courseId,
  question,
  onClose,
}: {
  courseId: string;
  question: QuestionDto;
  onClose: () => void;
}) {
  const [shown, setShown] = useState<number | null>(null);
  const versions = useQuery({
    queryKey: assessmentKeys.versions(courseId, question.id),
    queryFn: ({ signal }) => listVersions(courseId, question.id, signal),
  });
  const one = useQuery({
    queryKey: assessmentKeys.question(courseId, question.id, shown ?? undefined),
    queryFn: ({ signal }) => getQuestion(courseId, question.id, shown ?? undefined, signal),
    enabled: shown !== null,
  });
  return (
    <Dialog open onClose={onClose} title="Versions of this question">
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (axe) */}
      <div className="max-h-[65vh] space-y-3 overflow-y-auto" tabIndex={0}>
        {versions.isLoading && <ListSkeleton rows={2} label="Loading versions" />}
        {versions.isError && (
          <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
        )}
        <ul className="space-y-2">
          {versions.data?.items.map((v) => (
            <li
              key={v.versionId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-sm"
            >
              <span>
                Version {v.version}
                {v.current && ' (current)'} · {new Date(v.createdAt).toLocaleString()}
                {v.createdByName ? ` · ${v.createdByName}` : ''}
              </span>
              <Button variant="secondary" onClick={() => setShown(v.version)}>
                View
              </Button>
            </li>
          ))}
        </ul>
        {shown !== null && one.data && (
          <div className="space-y-2 rounded-md border border-border p-3 text-sm">
            <p className="font-medium">Version {one.data.version}</p>
            <RichTextView doc={one.data.stem} />
            {one.data.options.length > 0 && (
              <ul className="list-disc pl-5">
                {one.data.options.map((o) => (
                  <li key={o.id}>
                    {plainText(o.text)}
                    {o.correct ? ' ✓ correct' : ''}
                  </li>
                ))}
              </ul>
            )}
            {one.data.numeric && (
              <p>
                Correct: {one.data.numeric.value} (± {one.data.numeric.tolerance})
              </p>
            )}
            {one.data.shortAnswer?.accepted.length ? (
              <p>Accepted: {one.data.shortAnswer.accepted.join(', ')}</p>
            ) : null}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          To score past attempts with a corrected version, use "Regrade" on the assessment: it only
          applies when the options are the same.
        </p>
      </div>
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

function ImportDialog({
  courseId,
  onClose,
  onDone,
}: {
  courseId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [imp, setImp] = useState<QuestionImportDto | null>(null);
  const rows = useQuery({
    queryKey: ['question-import', courseId, imp?.id, 'invalid'],
    queryFn: () => importRows(courseId, imp?.id as string, 'invalid'),
    enabled: !!imp && imp.invalidRows > 0,
  });
  const upload = useMutation({
    mutationFn: (file: File) => uploadQuestionImport(courseId, file),
    onSuccess: setImp,
    onError: (err) => toast.error(describeError(err)),
  });
  const confirm = useMutation({
    mutationFn: (skipInvalid: boolean) => confirmImport(courseId, imp?.id as string, skipInvalid),
    onSuccess: (r) => {
      toast.success(`${r.createdCount} question${r.createdCount === 1 ? '' : 's'} added.`);
      onDone();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const cancel = useMutation({
    mutationFn: () => cancelImport(courseId, imp?.id as string),
    onSuccess: onClose,
    onError: (err) => toast.error(describeError(err)),
  });
  return (
    <Dialog
      open
      onClose={() => (imp ? cancel.mutate() : onClose())}
      title="Import questions from CSV"
    >
      <div className="max-h-[70vh] space-y-4 overflow-y-auto text-sm">
        {!imp ? (
          <>
            <p>
              Single choice, multiple choice and true / false questions, up to 1,000 rows. Check the
              file first: nothing is added until you confirm.
            </p>
            <Button
              variant="secondary"
              onClick={() =>
                void downloadQuestionTemplate(courseId).catch((e) => toast.error(describeError(e)))
              }
            >
              Download the template
            </Button>
            <label className="block space-y-1 font-medium">
              CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                disabled={upload.isPending}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload.mutate(f);
                }}
                className="block w-full text-sm"
              />
            </label>
            {upload.isPending && <p role="status">Checking the file…</p>}
          </>
        ) : (
          <>
            <p role="status" className="font-medium">
              {imp.fileName}: {imp.totalRows} rows, {imp.validRows} valid, {imp.invalidRows} with
              problems.
            </p>
            {imp.invalidRows > 0 && (
              <div className="space-y-2">
                {rows.isLoading && <p>Loading the problems…</p>}
                <ul className="space-y-2">
                  {rows.data?.items.map((r) => (
                    <li key={r.rowNo} className="rounded-md border border-danger p-2">
                      <p className="font-medium">
                        Row {r.rowNo}
                        {r.question ? `: ${r.question.slice(0, 80)}` : ''}
                      </p>
                      <ul className="list-disc pl-5 text-xs">
                        {r.errors.map((er) => (
                          <li key={`${er.column}-${er.message}`}>
                            {er.column}: {er.message}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
                {rows.data?.nextCursor !== null && rows.data && (
                  <p className="text-xs text-muted-foreground">The first 200 problems are shown.</p>
                )}
              </div>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="secondary"
                loading={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel the import
              </Button>
              {imp.invalidRows === 0 ? (
                <Button
                  loading={confirm.isPending}
                  disabled={imp.validRows === 0}
                  onClick={() => confirm.mutate(false)}
                >
                  Add {imp.validRows} questions
                </Button>
              ) : (
                <Button
                  loading={confirm.isPending}
                  disabled={imp.validRows === 0}
                  onClick={() => confirm.mutate(true)}
                >
                  Add the {imp.validRows} valid questions only
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
