import {
  CreateAcademicYearSchema,
  CreateBatchSchema,
  CreateDepartmentSchema,
  CreateProgramSchema,
  CreateSectionSchema,
  CreateTermSchema,
  UpdateAcademicYearSchema,
  UpdateBatchSchema,
  UpdateDepartmentSchema,
  UpdateProgramSchema,
  UpdateSectionSchema,
  UpdateTermSchema,
} from '@lms/backend/contracts';
import type { TSchema } from '@sinclair/typebox';
import type { EntityDto, EntityKey } from './academics.api';

export interface FieldSpec {
  name: string;
  label: string;
  kind: 'text' | 'date' | 'number';
  hint?: string;
  /** may be changed when editing (parents are immutable) */
  editable?: boolean;
}

export interface EntitySpec<K extends EntityKey = EntityKey> {
  key: K;
  tab: string;
  singular: string;
  /** shown in dialogs and toasts: "department CSE" */
  nameOf: (row: EntityDto[K]) => string;
  create: TSchema;
  update: TSchema;
  fields: FieldSpec[];
  columns: { header: string; value: (row: EntityDto[K]) => string }[];
}

export const ENTITIES: { [K in EntityKey]: EntitySpec<K> } = {
  years: {
    key: 'years',
    tab: 'Academic years',
    singular: 'academic year',
    nameOf: (r) => r.label,
    create: CreateAcademicYearSchema,
    update: UpdateAcademicYearSchema,
    fields: [
      { name: 'label', label: 'Label', kind: 'text', hint: 'For example 2025-26', editable: true },
      { name: 'startDate', label: 'Starts', kind: 'date', editable: true },
      { name: 'endDate', label: 'Ends', kind: 'date', editable: true },
    ],
    columns: [
      { header: 'Label', value: (r) => r.label },
      { header: 'Starts', value: (r) => r.startDate },
      { header: 'Ends', value: (r) => r.endDate },
    ],
  },
  terms: {
    key: 'terms',
    tab: 'Terms',
    singular: 'term',
    nameOf: (r) => r.name,
    create: CreateTermSchema,
    update: UpdateTermSchema,
    fields: [
      { name: 'name', label: 'Name', kind: 'text', hint: 'For example Semester 1', editable: true },
      { name: 'startDate', label: 'Starts', kind: 'date', editable: true },
      { name: 'endDate', label: 'Ends', kind: 'date', editable: true },
    ],
    columns: [
      { header: 'Name', value: (r) => r.name },
      { header: 'Starts', value: (r) => r.startDate },
      { header: 'Ends', value: (r) => r.endDate },
    ],
  },
  departments: {
    key: 'departments',
    tab: 'Departments',
    singular: 'department',
    nameOf: (r) => `${r.code} - ${r.name}`,
    create: CreateDepartmentSchema,
    update: UpdateDepartmentSchema,
    fields: [
      {
        name: 'code',
        label: 'Code',
        kind: 'text',
        hint: 'Short and unique, for example CSE',
        editable: true,
      },
      { name: 'name', label: 'Name', kind: 'text', editable: true },
    ],
    columns: [
      { header: 'Code', value: (r) => r.code },
      { header: 'Name', value: (r) => r.name },
    ],
  },
  programs: {
    key: 'programs',
    tab: 'Programs',
    singular: 'program',
    nameOf: (r) => r.code,
    create: CreateProgramSchema,
    update: UpdateProgramSchema,
    fields: [
      { name: 'code', label: 'Code', kind: 'text', hint: 'For example BE', editable: true },
      { name: 'name', label: 'Name', kind: 'text', editable: true },
      { name: 'durationYears', label: 'Duration (years)', kind: 'number', editable: true },
    ],
    columns: [
      { header: 'Code', value: (r) => r.code },
      { header: 'Name', value: (r) => r.name },
      { header: 'Years', value: (r) => String(r.durationYears) },
    ],
  },
  batches: {
    key: 'batches',
    tab: 'Batches',
    singular: 'batch',
    nameOf: (r) => r.label,
    create: CreateBatchSchema,
    update: UpdateBatchSchema,
    fields: [
      { name: 'admissionYear', label: 'Admission year', kind: 'number' },
      { name: 'graduationYear', label: 'Graduation year', kind: 'number', editable: true },
    ],
    columns: [
      { header: 'Batch', value: (r) => r.label },
      { header: 'Admission', value: (r) => String(r.admissionYear) },
      { header: 'Graduation', value: (r) => String(r.graduationYear) },
    ],
  },
  sections: {
    key: 'sections',
    tab: 'Sections',
    singular: 'section',
    nameOf: (r) => r.code,
    create: CreateSectionSchema,
    update: UpdateSectionSchema,
    fields: [{ name: 'code', label: 'Code', kind: 'text', hint: 'For example A', editable: true }],
    columns: [{ header: 'Section', value: (r) => r.code }],
  },
};

export const TAB_ORDER: EntityKey[] = [
  'years',
  'terms',
  'departments',
  'programs',
  'batches',
  'sections',
];
