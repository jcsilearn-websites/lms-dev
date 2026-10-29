import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { type EntityKey, listEntities, OPTIONS_LIMIT } from './academics.api';
import { EntityPanel } from './EntityPanel';
import { ENTITIES, TAB_ORDER } from './entities';
import { useAcademicOptions } from './useOptions';

/**
 * Academic setup: six tabs. A tab that belongs to a parent (terms to a year, programs to a
 * department, batches to a program, sections to a batch) first asks for the parent, so the lists
 * stay small and nothing loads the whole college's sections.
 */
export function AcademicsPage() {
  const [tab, setTab] = useState<EntityKey>('years');
  const [yearId, setYearId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [programId, setProgramId] = useState('');
  const [batchId, setBatchId] = useState('');

  const options = useAcademicOptions({
    departmentId: departmentId || undefined,
    programId: programId || undefined,
    batchId: batchId || undefined,
  });
  const years = useQuery({
    queryKey: ['options', 'years'],
    queryFn: ({ signal }) =>
      listEntities('years', { archived: 'false', limit: OPTIONS_LIMIT }, signal),
    staleTime: 5 * 60_000,
    enabled: tab === 'terms',
  });

  const pickDepartment = (id: string) => {
    setDepartmentId(id);
    setProgramId('');
    setBatchId('');
  };
  const pickProgram = (id: string) => {
    setProgramId(id);
    setBatchId('');
  };

  const needsDepartment = tab === 'programs' || tab === 'batches' || tab === 'sections';
  const needsProgram = tab === 'batches' || tab === 'sections';
  const needsBatch = tab === 'sections';

  let parent: Record<string, string | undefined> = {};
  let createParent: Record<string, string> = {};
  let blocked: string | undefined;
  if (tab === 'terms') {
    parent = { academicYearId: yearId || undefined };
    createParent = { academicYearId: yearId };
    if (!yearId) blocked = 'Choose an academic year to see its terms.';
  } else if (tab === 'programs') {
    parent = { departmentId };
    createParent = { departmentId };
    if (!departmentId) blocked = 'Choose a department to see its programs.';
  } else if (tab === 'batches') {
    parent = { programId };
    createParent = { programId };
    if (!programId) blocked = 'Choose a department and a program to see its batches.';
  } else if (tab === 'sections') {
    parent = { batchId };
    createParent = { batchId };
    if (!batchId) blocked = 'Choose a department, a program and a batch to see its sections.';
  }

  return (
    <div>
      <PageHeader
        title="Academic setup"
        description="Years, terms, departments, programs, batches and sections of your college."
      />
      <div
        role="tablist"
        aria-label="Academic setup"
        className="mb-4 flex gap-1 overflow-x-auto border-b border-border"
      >
        {TAB_ORDER.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`tab-${k}`}
            aria-selected={tab === k}
            aria-controls="academics-panel"
            tabIndex={tab === k ? 0 : -1}
            onClick={() => setTab(k)}
            onKeyDown={(e) => {
              const i = TAB_ORDER.indexOf(k);
              if (e.key === 'ArrowRight')
                setTab(TAB_ORDER[(i + 1) % TAB_ORDER.length] as EntityKey);
              if (e.key === 'ArrowLeft')
                setTab(TAB_ORDER[(i + TAB_ORDER.length - 1) % TAB_ORDER.length] as EntityKey);
            }}
            className="min-h-11 shrink-0 border-b-2 border-transparent px-3 text-sm font-medium aria-selected:border-primary aria-selected:text-primary sm:min-h-9"
          >
            {ENTITIES[k].tab}
          </button>
        ))}
      </div>

      <div
        id="academics-panel"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="space-y-4"
      >
        {(tab === 'terms' || needsDepartment) && (
          <div className="grid gap-2 sm:grid-cols-3">
            {tab === 'terms' && (
              <Select
                label="Academic year"
                value={yearId}
                onChange={(e) => setYearId(e.target.value)}
              >
                <option value="">Choose...</option>
                {years.data?.items.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.label}
                  </option>
                ))}
              </Select>
            )}
            {needsDepartment && (
              <Select
                label="Department"
                value={departmentId}
                onChange={(e) => pickDepartment(e.target.value)}
              >
                <option value="">Choose...</option>
                {options.departments.data?.items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code} - {d.name}
                  </option>
                ))}
              </Select>
            )}
            {needsProgram && (
              <Select
                label="Program"
                value={programId}
                disabled={!departmentId}
                onChange={(e) => pickProgram(e.target.value)}
              >
                <option value="">{departmentId ? 'Choose...' : 'Pick a department first'}</option>
                {options.programs.data?.items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code}
                  </option>
                ))}
              </Select>
            )}
            {needsBatch && (
              <Select
                label="Batch"
                value={batchId}
                disabled={!programId}
                onChange={(e) => setBatchId(e.target.value)}
              >
                <option value="">{programId ? 'Choose...' : 'Pick a program first'}</option>
                {options.batches.data?.items.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </Select>
            )}
          </div>
        )}
        <EntityPanel
          key={`${tab}:${yearId}:${departmentId}:${programId}:${batchId}`}
          entityKey={tab}
          parent={parent}
          createParent={createParent}
          blockedReason={blocked}
        />
      </div>
    </div>
  );
}
