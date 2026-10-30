import type {
  ImportDto,
  Member,
  MeResponse,
  ProfileDto,
  TenantDto,
  TenantInfo,
} from '@lms/backend/contracts';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

// The mocked API. Every body is typed with the backend contracts, so a contract change breaks these
// tests at compile time instead of silently drifting.

export const server = setupServer();

export const API = '*/api';

export const ADMIN_PERMISSIONS = [
  'tenant.manage',
  'member.read',
  'member.invite',
  'member.update_role',
  'member.suspend',
  'member.remove',
  'member.unlock',
  'audit.read',
  'academic.read',
  'academic.manage',
  'profile.read_own',
  'profile.manage',
  'import.run',
  'course.read',
  'course.create',
  'course.manage',
  'offering.manage',
  'participant.read',
  'content.view',
];

export const adminMe: MeResponse = {
  user: {
    id: '00000000-0000-7000-8000-000000000001',
    email: 'admin@alpha.test',
    displayName: 'Ada Admin',
  },
  tenant: { id: '00000000-0000-7000-8000-0000000000aa', slug: 'alpha' },
  role: 'institution_admin',
  isPlatformAdmin: false,
  permissions: ADMIN_PERMISSIONS,
};
export const memberMe: MeResponse = {
  ...adminMe,
  user: {
    id: '00000000-0000-7000-8000-000000000002',
    email: 'm@alpha.test',
    displayName: 'Mia Member',
  },
  role: 'member',
  permissions: ['academic.read', 'profile.read_own'],
};
export const platformMe: MeResponse = {
  user: {
    id: '00000000-0000-7000-8000-0000000000ff',
    email: 'root@platform.test',
    displayName: 'Root',
  },
  tenant: null,
  role: null,
  isPlatformAdmin: true,
  permissions: ['platform.tenant.read', 'platform.tenant.manage', 'platform.audit.read'],
};

export const tenantInfo: TenantInfo = {
  slug: 'alpha',
  displayName: 'Alpha College',
  primaryColor: '#2563eb',
};

export const member = (n: number, over: Partial<Member> = {}): Member => ({
  id: `10000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  userId: `20000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  email: `person${n}@alpha.test`,
  displayName: `Person ${n}`,
  role: 'member',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  profileType: null,
  registerNumber: null,
  employeeId: null,
  departmentId: null,
  batchId: null,
  sectionId: null,
  ...over,
});

export const studentProfile = (userId: string): ProfileDto => ({
  userId,
  profileType: 'student',
  phone: null,
  designation: null,
  registerNumber: 'R-1',
  employeeId: null,
  departmentId: 'd0000000-0000-7000-8000-000000000001',
  departmentCode: 'CSE',
  programId: 'e0000000-0000-7000-8000-000000000001',
  programCode: 'BE',
  programName: 'Bachelor of Engineering',
  batchId: 'b0000000-0000-7000-8000-000000000001',
  batchLabel: '2023-2027',
  sectionId: '50000000-0000-7000-8000-000000000001',
  sectionCode: 'A',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

export const importDto = (over: Partial<ImportDto> = {}): ImportDto => ({
  id: 'f0000000-0000-7000-8000-000000000001',
  kind: 'students',
  fileName: 'students.csv',
  status: 'validated',
  updateExisting: false,
  skipInvalid: false,
  counts: {
    total: 3,
    valid: 2,
    invalid: 1,
    processed: 0,
    skipped: 0,
    failed: 0,
    created: 0,
    updated: 0,
  },
  error: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  confirmedAt: null,
  startedAt: null,
  finishedAt: null,
  rowsPurged: false,
  ...over,
});

export const tenantDto = (over: Partial<TenantDto> = {}): TenantDto => ({
  id: 'c0000000-0000-7000-8000-000000000001',
  slug: 'alpha',
  name: 'Alpha College',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

export const errorBody = (code: string, message: string) => ({
  error: { code, message, requestId: 'req-test' },
});

/** The default handlers of a signed-in administrator; individual tests override what they exercise. */
export function mockSignedIn(me: MeResponse = adminMe) {
  server.use(
    http.get(`${API}/auth/me`, () => HttpResponse.json(me)),
    http.get(`${API}/tenant/info`, () => HttpResponse.json(tenantInfo)),
    // the home page lists "my courses": none unless a test says otherwise
    http.get(`${API}/me/courses`, () => HttpResponse.json({ items: [], nextCursor: null })),
  );
}

export function mockSignedOut() {
  server.use(
    http.get(`${API}/auth/me`, () =>
      HttpResponse.json(errorBody('unauthenticated', 'Authentication required'), { status: 401 }),
    ),
    http.get(`${API}/tenant/info`, () => HttpResponse.json(tenantInfo)),
  );
}
