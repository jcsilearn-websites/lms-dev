import {
  AcademicYearListQuerySchema,
  AcademicYearListSchema,
  AcademicYearSchema,
  AckSchema,
  BatchListQuerySchema,
  BatchListSchema,
  BatchSchema,
  COMMON_ERRORS,
  CreateAcademicYearSchema,
  CreateBatchSchema,
  CreateDepartmentSchema,
  CreateProgramSchema,
  CreateSectionSchema,
  CreateTermSchema,
  DepartmentListQuerySchema,
  DepartmentListSchema,
  DepartmentSchema,
  IdParamsSchema,
  ProgramListQuerySchema,
  ProgramListSchema,
  ProgramSchema,
  SectionListQuerySchema,
  SectionListSchema,
  SectionSchema,
  TermListQuerySchema,
  TermListSchema,
  TermSchema,
  UpdateAcademicYearSchema,
  UpdateBatchSchema,
  UpdateDepartmentSchema,
  UpdateProgramSchema,
  UpdateSectionSchema,
  UpdateTermSchema,
} from '../../contracts';
import { ENTITIES, ENTITY_KEYS, type EntityKey } from './academics.entities';

// the routes list the entities through this file (routes may only import schemas, controller and core)
export { ENTITY_KEYS };

const tags = ['academics'];

/** The request / response schemas of each entity (the DTO shapes live in contracts/academics.ts). */
const SCHEMAS = {
  'academic-years': {
    dto: AcademicYearSchema,
    list: AcademicYearListSchema,
    query: AcademicYearListQuerySchema,
    create: CreateAcademicYearSchema,
    update: UpdateAcademicYearSchema,
  },
  terms: {
    dto: TermSchema,
    list: TermListSchema,
    query: TermListQuerySchema,
    create: CreateTermSchema,
    update: UpdateTermSchema,
  },
  departments: {
    dto: DepartmentSchema,
    list: DepartmentListSchema,
    query: DepartmentListQuerySchema,
    create: CreateDepartmentSchema,
    update: UpdateDepartmentSchema,
  },
  programs: {
    dto: ProgramSchema,
    list: ProgramListSchema,
    query: ProgramListQuerySchema,
    create: CreateProgramSchema,
    update: UpdateProgramSchema,
  },
  batches: {
    dto: BatchSchema,
    list: BatchListSchema,
    query: BatchListQuerySchema,
    create: CreateBatchSchema,
    update: UpdateBatchSchema,
  },
  sections: {
    dto: SectionSchema,
    list: SectionListSchema,
    query: SectionListQuerySchema,
    create: CreateSectionSchema,
    update: UpdateSectionSchema,
  },
} as const;

/** The route schemas of the seven endpoints of one entity. */
export function entityRouteSchemas(key: EntityKey) {
  const e = ENTITIES[key];
  const s = SCHEMAS[key];
  return {
    list: {
      tags,
      summary: `List ${e.singular}s (keyset pagination; archived=false|true|all)`,
      querystring: s.query,
      response: { 200: s.list, ...COMMON_ERRORS },
    },
    get: {
      tags,
      summary: `One ${e.singular}`,
      params: IdParamsSchema,
      response: { 200: s.dto, ...COMMON_ERRORS },
    },
    create: {
      tags,
      summary: `Create a ${e.singular}`,
      body: s.create,
      response: { 201: s.dto, ...COMMON_ERRORS },
    },
    update: {
      tags,
      summary: `Change a ${e.singular} (its parent cannot change)`,
      params: IdParamsSchema,
      body: s.update,
      response: { 200: s.dto, ...COMMON_ERRORS },
    },
    archive: {
      tags,
      summary: `Archive a ${e.singular} (refused while active records below it exist)`,
      params: IdParamsSchema,
      response: { 200: s.dto, ...COMMON_ERRORS },
    },
    unarchive: {
      tags,
      summary: `Unarchive a ${e.singular} (refused while its parent is archived)`,
      params: IdParamsSchema,
      response: { 200: s.dto, ...COMMON_ERRORS },
    },
    remove: {
      tags,
      summary: `Delete a ${e.singular}: only when nothing references it (otherwise archive)`,
      params: IdParamsSchema,
      response: { 200: AckSchema, ...COMMON_ERRORS },
    },
  };
}

export const setCurrentRouteSchema = {
  tags,
  summary: 'Make this the (only) current academic year',
  params: IdParamsSchema,
  response: { 200: AcademicYearSchema, ...COMMON_ERRORS },
};
