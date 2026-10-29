import type {
  AcademicYearDto,
  BatchDto,
  DepartmentDto,
  ProgramDto,
  SectionDto,
  TermDto,
} from '@lms/backend/contracts';
import { api } from '../../shared/api/client';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** The six academic entities share one URL shape: /<path>, /<path>/:id, /<path>/:id/archive ... */
export type EntityKey = 'years' | 'terms' | 'departments' | 'programs' | 'batches' | 'sections';

export const ENTITY_PATH: Record<EntityKey, string> = {
  years: '/academic-years',
  terms: '/terms',
  departments: '/departments',
  programs: '/programs',
  batches: '/batches',
  sections: '/sections',
};

export interface EntityDto {
  years: AcademicYearDto;
  terms: TermDto;
  departments: DepartmentDto;
  programs: ProgramDto;
  batches: BatchDto;
  sections: SectionDto;
}

/** Options lists are always bounded (limit 100); the caller shows a hint when there is more. */
export const OPTIONS_LIMIT = 100;

type Query = Record<string, string | number | boolean | undefined>;

export const listEntities = <K extends EntityKey>(key: K, query: Query, signal?: AbortSignal) =>
  api<Page<EntityDto[K]>>(ENTITY_PATH[key], { query, signal });

export const createEntity = <K extends EntityKey>(key: K, body: Record<string, unknown>) =>
  api<EntityDto[K]>(ENTITY_PATH[key], { method: 'POST', body });

export const updateEntity = <K extends EntityKey>(
  key: K,
  id: string,
  body: Record<string, unknown>,
) => api<EntityDto[K]>(`${ENTITY_PATH[key]}/${id}`, { method: 'PATCH', body });

export const archiveEntity = <K extends EntityKey>(key: K, id: string) =>
  api<EntityDto[K]>(`${ENTITY_PATH[key]}/${id}/archive`, { method: 'POST' });

export const unarchiveEntity = <K extends EntityKey>(key: K, id: string) =>
  api<EntityDto[K]>(`${ENTITY_PATH[key]}/${id}/unarchive`, { method: 'POST' });

export const deleteEntity = (key: EntityKey, id: string) =>
  api<undefined>(`${ENTITY_PATH[key]}/${id}`, { method: 'DELETE' });

export const setCurrentYear = (id: string) =>
  api<AcademicYearDto>(`/academic-years/${id}/set-current`, { method: 'POST' });

// ---- cascading options (members filters, section move): each one is requested only when its parent is chosen
export const departmentOptions = (signal?: AbortSignal) =>
  listEntities('departments', { archived: 'false', limit: OPTIONS_LIMIT }, signal);
export const programOptions = (departmentId: string, signal?: AbortSignal) =>
  listEntities('programs', { departmentId, archived: 'false', limit: OPTIONS_LIMIT }, signal);
export const batchOptions = (programId: string, signal?: AbortSignal) =>
  listEntities('batches', { programId, archived: 'false', limit: OPTIONS_LIMIT }, signal);
export const sectionOptions = (batchId: string, signal?: AbortSignal) =>
  listEntities('sections', { batchId, archived: 'false', limit: OPTIONS_LIMIT }, signal);

export const optionKeys = {
  departments: ['options', 'departments'] as const,
  programs: (departmentId: string) => ['options', 'programs', departmentId] as const,
  batches: (programId: string) => ['options', 'batches', programId] as const,
  sections: (batchId: string) => ['options', 'sections', batchId] as const,
};
