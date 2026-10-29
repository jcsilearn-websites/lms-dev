import { isUuid } from '../../core/uuid';

// One description per academic entity: the repository builds its SQL from it, the service validates and
// normalizes with it, the routes are registered from it. Identifiers here are constants (never user
// input), so they can be put into SQL text; every value is still a bound parameter.

export type EntityKey =
  | 'academic-years'
  | 'terms'
  | 'departments'
  | 'programs'
  | 'batches'
  | 'sections';

export type FieldType = 'text' | 'code' | 'date' | 'int' | 'uuid';

export interface Field {
  /** API (camelCase) name */
  key: string;
  column: string;
  type: FieldType;
  /** false = settable on create only (a parent: immutable afterwards) */
  patchable: boolean;
  /** text/code: max length; int: [min, max] */
  max?: number;
  min?: number;
  /** code: the DB pattern, applied after trimming + uppercasing */
  pattern?: RegExp;
}

export interface Filter {
  param: string;
  column: string;
  type: 'uuid' | 'int';
}

export interface Entity {
  key: EntityKey;
  /** URL segment */
  path: string;
  table: string;
  /** shown in messages */
  singular: string;
  /** audit action prefix: academic.<audit>.created ... */
  audit: string;
  fields: Field[];
  filters: Filter[];
  /** extra columns returned besides id, the fields, archived_at, created_at, updated_at */
  extraColumns: string[];
}

const CODE_20 = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;
const CODE_10 = /^[A-Z0-9][A-Z0-9_-]{0,9}$/;

export const ENTITIES: Record<EntityKey, Entity> = {
  'academic-years': {
    key: 'academic-years',
    path: 'academic-years',
    table: 'academic_years',
    singular: 'academic year',
    audit: 'academic_year',
    fields: [
      { key: 'label', column: 'label', type: 'text', patchable: true, max: 32 },
      { key: 'startDate', column: 'start_date', type: 'date', patchable: true },
      { key: 'endDate', column: 'end_date', type: 'date', patchable: true },
    ],
    filters: [],
    extraColumns: ['is_current'],
  },
  terms: {
    key: 'terms',
    path: 'terms',
    table: 'terms',
    singular: 'term',
    audit: 'term',
    fields: [
      { key: 'academicYearId', column: 'academic_year_id', type: 'uuid', patchable: false },
      { key: 'name', column: 'name', type: 'text', patchable: true, max: 100 },
      { key: 'startDate', column: 'start_date', type: 'date', patchable: true },
      { key: 'endDate', column: 'end_date', type: 'date', patchable: true },
    ],
    filters: [{ param: 'academicYearId', column: 'academic_year_id', type: 'uuid' }],
    extraColumns: [],
  },
  departments: {
    key: 'departments',
    path: 'departments',
    table: 'departments',
    singular: 'department',
    audit: 'department',
    fields: [
      { key: 'code', column: 'code', type: 'code', patchable: true, pattern: CODE_20 },
      { key: 'name', column: 'name', type: 'text', patchable: true, max: 200 },
    ],
    filters: [],
    extraColumns: [],
  },
  programs: {
    key: 'programs',
    path: 'programs',
    table: 'programs',
    singular: 'program',
    audit: 'program',
    fields: [
      { key: 'departmentId', column: 'department_id', type: 'uuid', patchable: false },
      { key: 'code', column: 'code', type: 'code', patchable: true, pattern: CODE_20 },
      { key: 'name', column: 'name', type: 'text', patchable: true, max: 200 },
      {
        key: 'durationYears',
        column: 'duration_years',
        type: 'int',
        patchable: true,
        min: 1,
        max: 8,
      },
    ],
    filters: [{ param: 'departmentId', column: 'department_id', type: 'uuid' }],
    extraColumns: [],
  },
  batches: {
    key: 'batches',
    path: 'batches',
    table: 'batches',
    singular: 'batch',
    audit: 'batch',
    fields: [
      { key: 'programId', column: 'program_id', type: 'uuid', patchable: false },
      {
        key: 'admissionYear',
        column: 'admission_year',
        type: 'int',
        patchable: false,
        min: 1950,
        max: 2200,
      },
      {
        key: 'graduationYear',
        column: 'graduation_year',
        type: 'int',
        patchable: true,
        min: 1951,
        max: 2210,
      },
    ],
    filters: [
      { param: 'programId', column: 'program_id', type: 'uuid' },
      { param: 'admissionYear', column: 'admission_year', type: 'int' },
    ],
    extraColumns: [],
  },
  sections: {
    key: 'sections',
    path: 'sections',
    table: 'sections',
    singular: 'section',
    audit: 'section',
    fields: [
      { key: 'batchId', column: 'batch_id', type: 'uuid', patchable: false },
      { key: 'code', column: 'code', type: 'code', patchable: true, pattern: CODE_10 },
    ],
    filters: [{ param: 'batchId', column: 'batch_id', type: 'uuid' }],
    extraColumns: [],
  },
};

export const ENTITY_KEYS = Object.keys(ENTITIES) as EntityKey[];

/** The columns every query of an entity selects (explicit, never `*`). */
export function selectColumns(e: Entity): string[] {
  return [
    'id',
    ...e.fields.map((f) => f.column),
    ...e.extraColumns,
    'archived_at',
    'created_at',
    'updated_at',
  ];
}

export interface FieldProblem {
  path: string;
  message: string;
}

const isRealDate = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Normalizes one value (text: trimmed + single spaces; code: trimmed + uppercase) or reports why not. */
export function normalizeField(f: Field, value: unknown): { value: unknown } | { problem: string } {
  switch (f.type) {
    case 'text': {
      if (typeof value !== 'string') return { problem: 'must be text' };
      const v = value.trim().replace(/\s+/g, ' ');
      if (v.length === 0) return { problem: 'must not be empty' };
      if (f.max && v.length > f.max) return { problem: `must be at most ${f.max} characters` };
      return { value: v };
    }
    case 'code': {
      if (typeof value !== 'string') return { problem: 'must be text' };
      const v = value.trim().toUpperCase();
      if (f.pattern && !f.pattern.test(v)) {
        return { problem: 'use letters, digits, - and _ (must start with a letter or digit)' };
      }
      return { value: v };
    }
    case 'date': {
      if (typeof value !== 'string' || !isRealDate(value))
        return { problem: 'must be a date (YYYY-MM-DD)' };
      return { value };
    }
    case 'int': {
      if (typeof value !== 'number' || !Number.isInteger(value))
        return { problem: 'must be a whole number' };
      if ((f.min !== undefined && value < f.min) || (f.max !== undefined && value > f.max)) {
        return { problem: `must be between ${f.min} and ${f.max}` };
      }
      return { value };
    }
    case 'uuid': {
      if (typeof value !== 'string' || !isUuid(value)) return { problem: 'must be an id' };
      return { value };
    }
  }
}
