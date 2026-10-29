import { useQuery } from '@tanstack/react-query';
import {
  batchOptions,
  departmentOptions,
  optionKeys,
  programOptions,
  sectionOptions,
} from './academics.api';

const STALE = 5 * 60_000;

/**
 * Cascading options for the department -> program -> batch -> section pickers. Departments load up
 * front; programs only once a department is chosen, batches only once a program is chosen and
 * sections only once a batch is chosen: the sections of the whole college are never fetched. Every
 * request is bounded (limit 100); `truncated` tells the UI there is more than it shows.
 */
export function useAcademicOptions(sel: {
  departmentId?: string | undefined;
  programId?: string | undefined;
  batchId?: string | undefined;
}) {
  const departments = useQuery({
    queryKey: optionKeys.departments,
    queryFn: ({ signal }) => departmentOptions(signal),
    staleTime: STALE,
  });
  const programs = useQuery({
    queryKey: optionKeys.programs(sel.departmentId ?? ''),
    queryFn: ({ signal }) => programOptions(sel.departmentId as string, signal),
    enabled: !!sel.departmentId,
    staleTime: STALE,
  });
  const batches = useQuery({
    queryKey: optionKeys.batches(sel.programId ?? ''),
    queryFn: ({ signal }) => batchOptions(sel.programId as string, signal),
    enabled: !!sel.programId,
    staleTime: STALE,
  });
  const sections = useQuery({
    queryKey: optionKeys.sections(sel.batchId ?? ''),
    queryFn: ({ signal }) => sectionOptions(sel.batchId as string, signal),
    enabled: !!sel.batchId,
    staleTime: STALE,
  });
  return {
    departments,
    programs,
    batches,
    sections,
    truncated: [departments, programs, batches, sections].some((q) => !!q.data?.nextCursor),
  };
}
