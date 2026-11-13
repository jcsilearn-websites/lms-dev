import type {
  CategoryInput,
  ExportColumn,
  GradebookConfig,
  ItemInput,
  SettingsPatch,
} from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Card } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { toast } from '../../shared/ui/toast';
import {
  gradebookKeys,
  listScales,
  patchSettings,
  saveCategories,
  saveItems,
} from './gradebook.api';

// The instructor's settings: general (weighting, out of, rounding, grade scale), categories (weights, drop lowest, missing work),
// items (from the quizzes and assignments of the course, and manual columns) and the column layout of exports. Everything is
// disabled while the gradebook waits for approval or is locked; the API refuses it as well.

type Props = { offeringId: string; config: GradebookConfig; disabled: boolean };

function useSave<T>(offeringId: string, fn: (v: T) => Promise<GradebookConfig>, done: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (cfg) => {
      qc.setQueryData(gradebookKeys.config(offeringId), cfg);
      // the numbers of every learner may have changed
      void qc.invalidateQueries({ queryKey: ['gradebook', offeringId, 'grid'] });
      toast.success(done);
    },
    onError: (err) => toast.error(describeError(err)),
  });
}

const num = (s: string): number => Number(s.replace(',', '.'));

function General({ offeringId, config, disabled }: Props) {
  const scales = useQuery({
    queryKey: gradebookKeys.scales,
    queryFn: ({ signal }) => listScales(false, signal),
  });
  const [weighted, setWeighted] = useState(config.weighted);
  const [outOf, setOutOf] = useState(String(config.outOf));
  const [mode, setMode] = useState(config.roundMode);
  const [decimals, setDecimals] = useState(String(config.roundDecimals));
  const [scaleId, setScaleId] = useState(config.scale?.id ?? '');
  const save = useSave<SettingsPatch>(
    offeringId,
    (p) => patchSettings(offeringId, p),
    'Settings saved',
  );
  const valid = Number.isFinite(num(outOf)) && num(outOf) > 0;
  return (
    <Card title="General">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid)
            save.mutate({
              weighted,
              outOf: num(outOf),
              roundMode: mode,
              roundDecimals: Number(decimals),
              scaleId: scaleId === '' ? null : scaleId,
            });
        }}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={weighted}
            disabled={disabled}
            onChange={(e) => setWeighted(e.target.checked)}
          />
          Count categories by their weights (otherwise all points are added together)
        </label>
        <Field
          label="The final is out of (marks)"
          inputMode="decimal"
          value={outOf}
          disabled={disabled}
          onChange={(e) => setOutOf(e.target.value)}
          error={valid ? undefined : 'Enter a number above 0'}
        />
        <Select
          label="Grade scale"
          value={scaleId}
          disabled={disabled}
          onChange={(e) => setScaleId(e.target.value)}
          hint="Colleges keep their scales under Grade scales"
        >
          <option value="">No scale yet</option>
          {scales.data?.items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select
          label="Rounding of the final"
          value={mode}
          disabled={disabled}
          onChange={(e) => setMode(e.target.value as typeof mode)}
          hint="Only the final is rounded, never the steps before it"
        >
          <option value="half_up">Half up (0.5 goes up)</option>
          <option value="half_even">Half to even (banker's rounding)</option>
          <option value="floor">Always down</option>
          <option value="ceil">Always up</option>
        </Select>
        <Select
          label="Decimals of the final"
          value={decimals}
          disabled={disabled}
          onChange={(e) => setDecimals(e.target.value)}
        >
          <option value="0">Whole marks</option>
          <option value="1">1 decimal</option>
          <option value="2">2 decimals</option>
        </Select>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={disabled || !valid} loading={save.isPending}>
            Save general settings
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Categories({ offeringId, config, disabled }: Props) {
  const [rows, setRows] = useState<(CategoryInput & { key: string })[]>(
    config.categories.map((c) => ({ ...c, key: c.id })),
  );
  const save = useSave<CategoryInput[]>(
    offeringId,
    (c) => saveCategories(offeringId, c),
    'Categories saved',
  );
  const patch = (i: number, p: Partial<CategoryInput>) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: -1 | 1) =>
    setRows((r) => {
      const next = [...r];
      const [x] = next.splice(i, 1);
      if (x) next.splice(i + d, 0, x);
      return next;
    });
  const total = rows.reduce((s, r) => s + (Number.isFinite(r.weight) ? r.weight : 0), 0);
  const names = rows.map((r) => r.name.trim().toLowerCase());
  const valid =
    rows.length > 0 &&
    rows.every((r) => r.name.trim() !== '' && r.weight >= 0) &&
    new Set(names).size === names.length;
  return (
    <Card title="Categories">
      <ul className="space-y-3">
        {rows.map((r, i) => (
          <li key={r.key} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-6">
            <Field
              className="sm:col-span-2"
              label="Name"
              value={r.name}
              disabled={disabled}
              onChange={(e) => patch(i, { name: e.target.value })}
            />
            <Field
              label="Weight"
              inputMode="decimal"
              value={String(r.weight)}
              disabled={disabled}
              onChange={(e) => patch(i, { weight: num(e.target.value) || 0 })}
            />
            <Field
              label="Drop lowest"
              inputMode="numeric"
              value={String(r.dropLowest)}
              disabled={disabled}
              onChange={(e) =>
                patch(i, {
                  dropLowest: Math.max(0, Math.min(20, Math.floor(Number(e.target.value) || 0))),
                })
              }
            />
            <Select
              className="sm:col-span-2"
              label="Work that is missing"
              value={r.missingPolicy}
              disabled={disabled}
              onChange={(e) =>
                patch(i, { missingPolicy: e.target.value as CategoryInput['missingPolicy'] })
              }
            >
              <option value="exclude">Left out until it is graded</option>
              <option value="zero_after_due">Counts as 0 after the due date</option>
            </Select>
            <div className="flex flex-wrap gap-2 sm:col-span-6">
              <Button
                variant="secondary"
                disabled={disabled || i === 0}
                aria-label={`Move ${r.name || 'category'} up`}
                onClick={() => move(i, -1)}
              >
                Up
              </Button>
              <Button
                variant="secondary"
                disabled={disabled || i === rows.length - 1}
                aria-label={`Move ${r.name || 'category'} down`}
                onClick={() => move(i, 1)}
              >
                Down
              </Button>
              <Button
                variant="secondary"
                disabled={disabled || rows.length === 1}
                aria-label={`Remove the category ${r.name || ''}`}
                onClick={() => setRows((x) => x.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {config.weighted && (
        <p
          className={
            total === 100
              ? 'mt-3 text-sm text-muted-foreground'
              : 'mt-3 text-sm font-medium text-danger'
          }
          role="status"
        >
          Weights add up to {Number(total.toFixed(3))} (they must be 100 to submit).
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() =>
            setRows((r) => [
              ...r,
              {
                key: `new-${r.length}-${Date.now()}`,
                name: '',
                weight: 0,
                dropLowest: 0,
                missingPolicy: 'exclude',
              },
            ])
          }
        >
          Add a category
        </Button>
        <Button
          disabled={disabled || !valid}
          loading={save.isPending}
          onClick={() =>
            save.mutate(rows.map(({ key: _k, ...c }) => ({ ...c, name: c.name.trim() })))
          }
        >
          Save categories
        </Button>
      </div>
    </Card>
  );
}

type ItemRow = ItemInput & { key: string; label: string };

function Items({ offeringId, config, disabled }: Props) {
  const [rows, setRows] = useState<ItemRow[]>(
    config.items.map((i) => ({
      key: i.id,
      label: i.title,
      id: i.id,
      source: i.source,
      contentItemId: i.contentItemId,
      title: i.source === 'manual' ? i.title : null,
      categoryId: i.categoryId,
      points: i.points,
      extraCredit: i.extraCredit,
      dueAt: i.dueAt,
      released: i.released,
      assistantsMayEnter: i.assistantsMayEnter,
    })),
  );
  const [pick, setPick] = useState('');
  const firstCategory = config.categories[0]?.id ?? '';
  const save = useSave<ItemInput[]>(offeringId, (i) => saveItems(offeringId, i), 'Items saved');
  const patch = (i: number, p: Partial<ItemRow>) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const taken = new Set(rows.map((r) => r.contentItemId).filter(Boolean));
  const candidates = config.candidates.filter((c) => !taken.has(c.contentItemId));
  const valid = rows.every(
    (r) => r.points > 0 && (r.source !== 'manual' || (r.title ?? '').trim() !== ''),
  );
  return (
    <Card title="Items">
      {rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No items yet. Add a quiz or an assignment of the course, or a manual column for marks
          earned outside the LMS.
        </p>
      )}
      <ul className="space-y-3">
        {rows.map((r, i) => (
          <li key={r.key} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-6">
            {r.source === 'manual' ? (
              <Field
                className="sm:col-span-2"
                label="Column name"
                value={r.title ?? ''}
                disabled={disabled}
                onChange={(e) => patch(i, { title: e.target.value })}
              />
            ) : (
              <div className="sm:col-span-2">
                <p className="text-sm font-medium">{r.label}</p>
                <p className="text-xs text-muted-foreground">
                  {r.source === 'assessment'
                    ? 'Quiz or exam: released scores only'
                    : 'Assignment: released grades only'}
                </p>
              </div>
            )}
            <Select
              className="sm:col-span-2"
              label="Category"
              value={r.categoryId}
              disabled={disabled}
              onChange={(e) => patch(i, { categoryId: e.target.value })}
            >
              {config.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Field
              label="Worth (points)"
              inputMode="decimal"
              value={String(r.points)}
              disabled={disabled}
              onChange={(e) => patch(i, { points: num(e.target.value) || 0 })}
            />
            <label className="flex min-h-11 items-end gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={r.extraCredit}
                disabled={disabled}
                onChange={(e) => patch(i, { extraCredit: e.target.checked })}
              />
              Extra credit
            </label>
            {r.source === 'manual' && (
              <>
                <Field
                  className="sm:col-span-2"
                  label="Due (optional)"
                  type="datetime-local"
                  value={r.dueAt ? r.dueAt.slice(0, 16) : ''}
                  disabled={disabled}
                  onChange={(e) =>
                    patch(i, {
                      dueAt: e.target.value ? new Date(e.target.value).toISOString() : null,
                    })
                  }
                />
                <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={r.released === true}
                    disabled={disabled}
                    onChange={(e) => patch(i, { released: e.target.checked })}
                  />
                  Learners can see these marks
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={r.assistantsMayEnter === true}
                    disabled={disabled}
                    onChange={(e) => patch(i, { assistantsMayEnter: e.target.checked })}
                  />
                  Assistants may enter marks
                </label>
              </>
            )}
            <div className="sm:col-span-6">
              <Button
                variant="secondary"
                disabled={disabled}
                aria-label={`Remove from the gradebook: ${r.label || r.title || 'item'}`}
                onClick={() => setRows((x) => x.filter((_, j) => j !== i))}
              >
                Remove from the gradebook
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <Select
          label="Add a quiz or assignment"
          value={pick}
          disabled={disabled || candidates.length === 0}
          onChange={(e) => setPick(e.target.value)}
        >
          <option value="">
            {candidates.length === 0 ? 'Everything is in the gradebook' : 'Choose…'}
          </option>
          {candidates.map((c) => (
            <option key={c.contentItemId} value={c.contentItemId}>
              {c.title} ({c.kind === 'assessment' ? 'quiz' : 'assignment'})
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          disabled={disabled || pick === ''}
          onClick={() => {
            const c = config.candidates.find((x) => x.contentItemId === pick);
            if (!c) return;
            setRows((r) => [
              ...r,
              {
                key: `c-${pick}`,
                label: c.title,
                source: c.kind,
                contentItemId: c.contentItemId,
                categoryId: firstCategory,
                points: c.defaultPoints,
                extraCredit: false,
              },
            ]);
            setPick('');
          }}
        >
          Add
        </Button>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() =>
            setRows((r) => [
              ...r,
              {
                key: `m-${r.length}-${Date.now()}`,
                label: '',
                source: 'manual',
                title: '',
                categoryId: firstCategory,
                points: 10,
                extraCredit: false,
                released: false,
                assistantsMayEnter: false,
              },
            ])
          }
        >
          Add a manual column
        </Button>
      </div>
      <div className="mt-3">
        <Button
          disabled={disabled || !valid}
          loading={save.isPending}
          onClick={() =>
            save.mutate(
              rows.map(({ key: _k, label: _l, ...i }) => ({
                ...i,
                ...(i.source === 'manual' ? { title: (i.title ?? '').trim() } : {}),
              })),
            )
          }
        >
          Save items
        </Button>
      </div>
    </Card>
  );
}

function ExportLayout({ offeringId, config, disabled }: Props) {
  const defaults: ExportColumn[] = [
    { key: 'register', header: 'Register number' },
    { key: 'name', header: 'Name' },
    ...config.items.map((i) => ({ key: `item:${i.id}`, header: i.title })),
    ...config.categories.map((c) => ({ key: `cat:${c.id}`, header: `${c.name} (%)` })),
    { key: 'final', header: 'Final marks' },
    { key: 'percent', header: 'Final percent' },
    { key: 'grade', header: 'Grade' },
  ];
  const optional: ExportColumn[] = [
    { key: 'email', header: 'E-mail' },
    { key: 'section', header: 'Section' },
  ];
  const start = config.exportLayout ?? defaults;
  const used = new Set(start.map((c) => c.key));
  const [cols, setCols] = useState<ExportColumn[]>([
    ...start,
    ...[...defaults, ...optional].filter((c) => !used.has(c.key)).map((c) => ({ ...c })),
  ]);
  const [on, setOn] = useState<Set<string>>(used);
  const save = useSave<SettingsPatch>(
    offeringId,
    (p) => patchSettings(offeringId, p),
    'Export layout saved',
  );
  const move = (i: number, d: -1 | 1) =>
    setCols((r) => {
      const next = [...r];
      const [x] = next.splice(i, 1);
      if (x) next.splice(i + d, 0, x);
      return next;
    });
  const chosen = cols.filter((c) => on.has(c.key));
  return (
    <Card title="Export layout">
      <p className="mb-3 text-sm text-muted-foreground">
        The columns, their order and their headings in the CSV and Excel files of an approved
        gradebook (for uploading to a university portal).
      </p>
      <ul className="space-y-2">
        {cols.map((c, i) => (
          <li key={c.key} className="grid items-end gap-2 sm:grid-cols-[auto_1fr_auto]">
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={on.has(c.key)}
                disabled={disabled}
                onChange={(e) =>
                  setOn((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(c.key);
                    else n.delete(c.key);
                    return n;
                  })
                }
              />
              Include
            </label>
            <Field
              label={`Heading of ${c.key.startsWith('item:') || c.key.startsWith('cat:') ? c.header : c.key}`}
              value={c.header}
              disabled={disabled}
              maxLength={80}
              onChange={(e) =>
                setCols((r) => r.map((x, j) => (j === i ? { ...x, header: e.target.value } : x)))
              }
            />
            <span className="flex gap-2">
              <Button
                variant="secondary"
                disabled={disabled || i === 0}
                aria-label={`Move ${c.header} up`}
                onClick={() => move(i, -1)}
              >
                Up
              </Button>
              <Button
                variant="secondary"
                disabled={disabled || i === cols.length - 1}
                aria-label={`Move ${c.header} down`}
                onClick={() => move(i, 1)}
              >
                Down
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          disabled={disabled || chosen.length === 0 || chosen.some((c) => c.header.trim() === '')}
          loading={save.isPending}
          onClick={() =>
            save.mutate({
              exportLayout: chosen.map((c) => ({ key: c.key, header: c.header.trim() })),
            })
          }
        >
          Save layout
        </Button>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => save.mutate({ exportLayout: null })}
        >
          Use the standard layout
        </Button>
      </div>
    </Card>
  );
}

export function SettingsPanel(props: Props) {
  // remount the editors when the saved structure changes elsewhere (their drafts start from the saved values)
  const k = JSON.stringify([
    props.config.categories,
    props.config.items.length,
    props.config.versionNo,
    props.config.status,
  ]);
  return (
    <div className="space-y-4">
      {props.disabled && (
        <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">
          {props.config.status === 'locked'
            ? 'This gradebook is locked. An administrator has to unlock it before anything can change.'
            : 'This gradebook is waiting for approval. It cannot change until it is approved or returned.'}
        </p>
      )}
      <General key={`g-${k}`} {...props} />
      <Categories key={`c-${k}`} {...props} />
      <Items key={`i-${k}`} {...props} />
      <ExportLayout key={`e-${k}`} {...props} />
    </div>
  );
}
