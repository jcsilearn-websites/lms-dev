import type {
  CourseDto,
  OfferingDto,
  OutlineDto,
  OutlineItem,
  OutlineModule,
  ParticipantDto,
} from '@lms/backend/contracts';

// Typed with the contracts: when a contract changes, these stop compiling.

export const STAMP = '2026-01-01T00:00:00.000Z';
const id = (n: number) => `0${n}000000-0000-7000-8000-000000000001`.slice(0, 36);

export const offering = (over: Partial<OfferingDto> = {}): OfferingDto => ({
  id: id(1),
  courseId: id(2),
  courseCode: 'CS101',
  courseTitle: 'Programming',
  title: 'Programming',
  label: '',
  termId: id(3),
  termName: 'Semester 1',
  status: 'published',
  copyStatus: 'none',
  myParticipation: 'learner',
  sectionCount: 1,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

export const course = (over: Partial<CourseDto> = {}): CourseDto => ({
  id: id(2),
  code: 'CS101',
  title: 'Programming',
  description: '',
  credits: 4,
  departmentId: null,
  departmentCode: null,
  departmentName: null,
  archivedAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

export const item = (n: number, over: Partial<OutlineItem> = {}): OutlineItem => ({
  id: `a${n}000000-0000-7000-8000-000000000001`,
  moduleId: id(4),
  kind: 'text',
  title: `Item ${n}`,
  published: true,
  availableFrom: null,
  locked: false,
  url: null,
  file: null,
  video: null,
  hasBody: true,
  ...over,
});

export const moduleOf = (
  n: number,
  items: OutlineItem[],
  over: Partial<OutlineModule> = {},
): OutlineModule => ({
  id: `b${n}000000-0000-7000-8000-000000000001`,
  title: `Module ${n}`,
  published: true,
  availableFrom: null,
  items: items.map((i) => ({ ...i, moduleId: `b${n}000000-0000-7000-8000-000000000001` })),
  ...over,
});

export const outline = (
  modules: OutlineModule[],
  canEdit = false,
  offeringId = id(1),
): OutlineDto => ({
  offeringId,
  canEdit,
  modules,
});

export const participant = (n: number, over: Partial<ParticipantDto> = {}): ParticipantDto => ({
  id: `c${n}000000-0000-7000-8000-000000000001`,
  userId: `d${n}000000-0000-7000-8000-000000000001`,
  displayName: `Person ${n}`,
  email: `p${n}@example.test`,
  participation: 'learner',
  source: 'manual',
  sectionCode: null,
  status: 'active',
  createdAt: STAMP,
  ...over,
});

export const OFFERING_ID = id(1);
