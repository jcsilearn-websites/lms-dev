import type { QuestionDto, QuestionInput } from '@lms/backend/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { describeError } from '../../../shared/api/errors';
import { plainText } from '../../../shared/richtext/RichTextView';
import { Button } from '../../../shared/ui/button';
import { Dialog } from '../../../shared/ui/dialog';
import { Field } from '../../../shared/ui/field';
import { Select } from '../../../shared/ui/select';
import { Skeleton } from '../../../shared/ui/states';
import { toast } from '../../../shared/ui/toast';
import { loadEditor } from '../../courses/editor/loadEditor';
import { createQuestion, questionImage, updateQuestion } from '../assessments.api';
import { TYPE_LABEL } from '../labels';
import { uploadQuestionImage } from '../uploadImage';

// Create or edit a question. Editing saves a NEW VERSION: attempts that already showed the old one keep it. The stem
// uses the rich-text editor (its own chunk, loaded only here and in the builder); options and answers are plain text
// that is stored as the same validated rich-text tree.

const RichTextEditor = lazy(loadEditor);

const doc = (text: string) => ({
  type: 'doc' as const,
  content: text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
});

interface OptionRow {
  id?: string | undefined;
  text: string;
  correct: boolean;
}

interface Form {
  type: QuestionInput['type'];
  difficulty: 'easy' | 'medium' | 'hard';
  stem: unknown;
  options: OptionRow[];
  partialCredit: boolean;
  trueIsCorrect: boolean;
  numValue: string;
  numTolerance: string;
  numMode: 'absolute' | 'percent';
  shortMode: 'auto' | 'manual';
  accepted: string;
  maxWords: string;
  explanation: string;
  tags: string;
  images: { fileId: string; alt: string }[];
}

const blank = (): Form => ({
  type: 'single_choice',
  difficulty: 'medium',
  stem: null,
  options: [
    { text: '', correct: true },
    { text: '', correct: false },
  ],
  partialCredit: false,
  trueIsCorrect: true,
  numValue: '',
  numTolerance: '0',
  numMode: 'absolute',
  shortMode: 'auto',
  accepted: '',
  maxWords: '',
  explanation: '',
  tags: '',
  images: [],
});

function fromQuestion(q: QuestionDto): Form {
  return {
    type: q.type,
    difficulty: q.difficulty,
    stem: q.stem,
    options:
      q.options.length > 0
        ? q.options.map((o) => ({ id: o.id, text: plainText(o.text), correct: o.correct }))
        : blank().options,
    partialCredit: q.partialCredit,
    trueIsCorrect: q.trueIsCorrect ?? true,
    numValue: q.numeric ? String(q.numeric.value) : '',
    numTolerance: q.numeric ? String(q.numeric.tolerance) : '0',
    numMode: q.numeric?.mode ?? 'absolute',
    shortMode: q.shortAnswer?.mode ?? 'auto',
    accepted: (q.shortAnswer?.accepted ?? []).join('\n'),
    maxWords: q.maxWords ? String(q.maxWords) : '',
    explanation: q.explanation ? plainText(q.explanation) : '',
    tags: q.tags.join(', '),
    images: q.images,
  };
}

function toInput(f: Form): QuestionInput {
  const stem = (f.stem ?? { type: 'doc', content: [] }) as QuestionInput['stem'];
  const base: QuestionInput = {
    type: f.type,
    difficulty: f.difficulty,
    stem,
    tags: f.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    ...(f.images.length > 0 ? { images: f.images } : {}),
    ...(f.explanation.trim() ? { explanation: doc(f.explanation) as QuestionInput['stem'] } : {}),
  };
  if (f.type === 'single_choice' || f.type === 'multiple_choice') {
    return {
      ...base,
      options: f.options.map((o) => ({
        ...(o.id ? { id: o.id } : {}),
        text: doc(o.text) as QuestionInput['stem'],
        correct: o.correct,
      })),
      ...(f.type === 'multiple_choice' ? { partialCredit: f.partialCredit } : {}),
    };
  }
  if (f.type === 'true_false') return { ...base, trueIsCorrect: f.trueIsCorrect };
  if (f.type === 'numeric') {
    return {
      ...base,
      numeric: {
        value: Number(f.numValue.replace(',', '.')),
        tolerance: Number(f.numTolerance.replace(',', '.') || 0),
        mode: f.numMode,
      },
    };
  }
  if (f.type === 'short_answer') {
    return {
      ...base,
      shortAnswer: {
        mode: f.shortMode,
        ...(f.shortMode === 'auto'
          ? {
              accepted: f.accepted
                .split('\n')
                .map((a) => a.trim())
                .filter(Boolean),
            }
          : {}),
      },
    };
  }
  return { ...base, ...(f.maxWords ? { maxWords: Number(f.maxWords) } : {}) };
}

export function QuestionDialog({
  courseId,
  question,
  onClose,
  onSaved,
}: {
  courseId: string;
  question?: QuestionDto | undefined;
  onClose: () => void;
  onSaved: (q: QuestionDto, created: boolean) => void;
}) {
  const editing = !!question;
  const [f, setF] = useState<Form>(() => (question ? fromQuestion(question) : blank()));
  const [uploading, setUploading] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = useMutation({
    mutationFn: () =>
      question
        ? updateQuestion(courseId, question.id, toInput(f))
        : createQuestion(courseId, toInput(f)),
    onSuccess: (saved) => {
      toast.success(editing ? `Saved as version ${saved.version}.` : 'Question added.');
      onSaved(saved, !editing);
    },
    onError: (err) => setProblem(describeError(err)),
  });

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    setUploading(0);
    try {
      const done = await uploadQuestionImage(courseId, file, setUploading);
      set('images', [...f.images, { fileId: done.id, alt: '' }]);
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setUploading(null);
    }
  };

  const choice = f.type === 'single_choice' || f.type === 'multiple_choice';
  const valid =
    f.stem !== null &&
    plainText(f.stem).trim() !== '' &&
    (!choice ||
      (f.options.length >= 2 &&
        f.options.every((o) => o.text.trim() !== '') &&
        f.options.some((o) => o.correct))) &&
    (f.type !== 'numeric' || Number.isFinite(Number(f.numValue.replace(',', '.')))) &&
    (f.type !== 'short_answer' || f.shortMode === 'manual' || f.accepted.trim() !== '') &&
    f.images.every((i) => i.alt.trim() !== '');

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? `Edit question (version ${question.version})` : 'New question'}
    >
      <form
        className="max-h-[75vh] space-y-4 overflow-y-auto pr-1"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setProblem(null);
          save.mutate();
        }}
      >
        {editing && (
          <p className="rounded-md border border-border p-2 text-xs text-muted-foreground">
            Saving makes a new version. Attempts that already showed the current one keep it, with
            its answers and scores.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Type"
            value={f.type}
            disabled={editing}
            onChange={(e) => set('type', e.target.value as Form['type'])}
          >
            {Object.entries(TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Select
            label="Difficulty"
            value={f.difficulty}
            onChange={(e) => set('difficulty', e.target.value as Form['difficulty'])}
          >
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </Select>
        </div>

        <div className="space-y-1">
          <p className="text-sm font-medium">Question text</p>
          <Suspense fallback={<Skeleton className="h-32 w-full" />}>
            <RichTextEditor label="Question text" value={f.stem} onChange={(d) => set('stem', d)} />
          </Suspense>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Images (PNG or JPEG)</p>
          {f.images.map((img, i) => (
            <div
              key={img.fileId}
              className="flex flex-wrap items-end gap-2 rounded-md border border-border p-2"
            >
              <ImagePreview courseId={courseId} questionId={question?.id} fileId={img.fileId} />
              <Field
                className="min-w-48 flex-1"
                label="Describe the image (for screen readers)"
                value={img.alt}
                onChange={(e) =>
                  set(
                    'images',
                    f.images.map((x, j) => (j === i ? { ...x, alt: e.target.value } : x)),
                  )
                }
              />
              <Button
                variant="secondary"
                onClick={() =>
                  set(
                    'images',
                    f.images.filter((_, j) => j !== i),
                  )
                }
              >
                Remove
              </Button>
            </div>
          ))}
          {f.images.length < 4 && (
            <label className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-input px-3 text-sm hover:bg-muted sm:min-h-9">
              {uploading !== null ? `Uploading ${Math.round(uploading * 100)}%…` : 'Add an image'}
              <input
                type="file"
                accept="image/png,image/jpeg"
                className="sr-only"
                disabled={uploading !== null}
                onChange={(e) => {
                  void pickImage(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>

        {choice && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Options (
              {f.type === 'single_choice'
                ? 'mark the one correct option'
                : 'mark every correct option'}
              )
            </legend>
            {f.options.map((o, i) => (
              <div key={o.id ?? `new-${i}`} className="flex items-center gap-2">
                <input
                  type={f.type === 'single_choice' ? 'radio' : 'checkbox'}
                  name="correct"
                  aria-label={`Option ${i + 1} is correct`}
                  checked={o.correct}
                  className="size-5"
                  onChange={(e) =>
                    set(
                      'options',
                      f.options.map((x, j) =>
                        f.type === 'single_choice'
                          ? { ...x, correct: j === i }
                          : j === i
                            ? { ...x, correct: e.target.checked }
                            : x,
                      ),
                    )
                  }
                />
                <input
                  aria-label={`Option ${i + 1} text`}
                  value={o.text}
                  maxLength={500}
                  onChange={(e) =>
                    set(
                      'options',
                      f.options.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                    )
                  }
                  className="block min-h-11 w-full rounded-md border border-input bg-surface px-3 text-base sm:min-h-9 sm:text-sm"
                />
                <Button
                  variant="ghost"
                  aria-label={`Remove option ${i + 1}`}
                  disabled={f.options.length <= 2}
                  onClick={() =>
                    set(
                      'options',
                      f.options.filter((_, j) => j !== i),
                    )
                  }
                >
                  ✕
                </Button>
              </div>
            ))}
            {f.options.length < 10 && (
              <Button
                variant="secondary"
                onClick={() => set('options', [...f.options, { text: '', correct: false }])}
              >
                Add an option
              </Button>
            )}
            {f.type === 'multiple_choice' && (
              <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={f.partialCredit}
                  onChange={(e) => set('partialCredit', e.target.checked)}
                />
                Partial credit (each right option earns a share, each wrong one takes one away;
                never below zero)
              </label>
            )}
          </fieldset>
        )}
        {f.type === 'true_false' && (
          <Select
            label="The statement is"
            value={f.trueIsCorrect ? 'true' : 'false'}
            onChange={(e) => set('trueIsCorrect', e.target.value === 'true')}
          >
            <option value="true">True</option>
            <option value="false">False</option>
          </Select>
        )}
        {f.type === 'numeric' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label="Correct number"
              inputMode="decimal"
              value={f.numValue}
              onChange={(e) => set('numValue', e.target.value)}
            />
            <Field
              label="Tolerance (± )"
              inputMode="decimal"
              value={f.numTolerance}
              onChange={(e) => set('numTolerance', e.target.value)}
            />
            <Select
              label="Tolerance is"
              value={f.numMode}
              onChange={(e) => set('numMode', e.target.value as Form['numMode'])}
            >
              <option value="absolute">An amount</option>
              <option value="percent">A percentage</option>
            </Select>
          </div>
        )}
        {f.type === 'short_answer' && (
          <div className="space-y-3">
            <Select
              label="Marking"
              value={f.shortMode}
              onChange={(e) => set('shortMode', e.target.value as Form['shortMode'])}
            >
              <option value="auto">Automatic: exact match with an accepted answer</option>
              <option value="manual">By hand (it goes to the grading queue)</option>
            </Select>
            {f.shortMode === 'auto' && (
              <label className="block space-y-1 text-sm font-medium">
                Accepted answers, one per line
                <textarea
                  rows={3}
                  value={f.accepted}
                  onChange={(e) => set('accepted', e.target.value)}
                  className="block w-full rounded-md border border-input bg-surface p-2 text-base sm:text-sm"
                />
                <span className="block text-xs font-normal text-muted-foreground">
                  Capital letters, extra spaces and accents in the learner's answer are ignored when
                  comparing.
                </span>
              </label>
            )}
          </div>
        )}
        {f.type === 'essay' && (
          <Field
            label="About how many words (optional)"
            inputMode="numeric"
            value={f.maxWords}
            onChange={(e) => set('maxWords', e.target.value.replace(/\D/g, ''))}
          />
        )}

        <label className="block space-y-1 text-sm font-medium">
          Explanation (shown with the answers when results are released)
          <textarea
            rows={2}
            value={f.explanation}
            onChange={(e) => set('explanation', e.target.value)}
            className="block w-full rounded-md border border-input bg-surface p-2 text-base sm:text-sm"
          />
        </label>
        <Field
          label="Tags, separated by commas"
          hint="Random pools draw by tag and difficulty."
          value={f.tags}
          onChange={(e) => set('tags', e.target.value)}
        />

        {problem && (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending} disabled={!valid || uploading !== null}>
            {editing ? 'Save as a new version' : 'Add question'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ImagePreview({
  courseId,
  questionId,
  fileId,
}: {
  courseId: string;
  questionId: string | undefined;
  fileId: string;
}) {
  // a picture that was just uploaded has no question yet: it is shown once the question is saved
  const target = useQuery({
    queryKey: ['question-image', courseId, questionId, fileId],
    queryFn: () => questionImage(courseId, questionId as string, fileId),
    enabled: !!questionId,
    staleTime: 4 * 60_000,
  });
  if (!target.data)
    return (
      <span className="inline-flex size-12 items-center justify-center rounded-md border border-border text-xs">
        PNG
      </span>
    );
  return (
    <img
      src={target.data.url}
      alt=""
      className="size-12 rounded-md border border-border object-cover"
    />
  );
}
