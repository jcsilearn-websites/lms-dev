import type { ProfileType } from '../../contracts';
import { can } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { ForbiddenError } from '../../core/errors';
import { isUuid, newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import { MemberNotFoundError } from '../memberships';
import {
  InvalidProfileValueError,
  mapProfileDbError,
  NothingToUpdateError,
  ProfileNotFoundError,
  SectionNotFoundError,
} from './profiles.errors';
import type { ProfilesRepository, ProfileValues, Row } from './profiles.repository';

export type { Row } from './profiles.repository';

/** The PATCH body (see contracts/profiles.ts): any subset; `null` clears a field. */
export interface ProfileInput {
  profileType?: ProfileType | undefined;
  phone?: string | null | undefined;
  designation?: string | null | undefined;
  registerNumber?: string | null | undefined;
  employeeId?: string | null | undefined;
  departmentId?: string | null | undefined;
  batchId?: string | null | undefined;
  sectionId?: string | null | undefined;
}

export interface MoveOutcome {
  moved: number;
  unchanged: number;
  skipped: string[];
}

const PHONE = /^\+?[0-9][0-9 -]{5,18}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9./_-]{0,39}$/;

export function createProfilesService(deps: {
  db: Pick<Database, 'withTenant'>;
  profilesRepo: ProfilesRepository;
}) {
  const { db, profilesRepo } = deps;

  function tenantFor(
    ctx: RequestContext,
    permission: 'profile.manage' | 'profile.read_own',
  ): string {
    if (!ctx.tenantId || !can(ctx, permission)) throw new ForbiddenError();
    return ctx.tenantId;
  }

  /** Validates and normalizes the sent fields into column values. */
  function toValues(input: ProfileInput): ProfileValues {
    const out: ProfileValues = {};
    const problems: { path: string; message: string }[] = [];
    const text = (
      key: keyof ProfileInput,
      column: keyof ProfileValues,
      ok: (v: string) => boolean,
      message: string,
    ) => {
      const v = input[key];
      if (v === undefined) return;
      if (v === null) {
        out[column] = null;
        return;
      }
      const t = String(v).trim().replace(/\s+/g, ' ');
      if (t.length === 0 || !ok(t)) problems.push({ path: key, message });
      else out[column] = t;
    };
    const id = (key: keyof ProfileInput, column: keyof ProfileValues) => {
      const v = input[key];
      if (v === undefined) return;
      if (v !== null && !isUuid(String(v))) problems.push({ path: key, message: 'must be an id' });
      else out[column] = v as string | null;
    };
    if (input.profileType !== undefined) out.profile_type = input.profileType;
    text(
      'phone',
      'phone',
      (v) => PHONE.test(v),
      'use digits, spaces and hyphens, with an optional leading +',
    );
    text('designation', 'designation', (v) => v.length <= 100, 'must be at most 100 characters');
    text(
      'registerNumber',
      'register_number',
      (v) => KEY.test(v),
      'letters, digits and . / _ - only',
    );
    text('employeeId', 'employee_id', (v) => KEY.test(v), 'letters, digits and . / _ - only');
    id('departmentId', 'department_id');
    id('batchId', 'batch_id');
    id('sectionId', 'section_id');

    // a clearly inconsistent request is refused here with a helpful message; the database enforces it too
    const type = input.profileType;
    if (type === 'student' && out.employee_id) {
      problems.push({
        path: 'employeeId',
        message: 'students have a registerNumber, not an employeeId',
      });
    }
    if (type !== undefined && type !== 'student') {
      for (const [k, c] of [
        ['registerNumber', 'register_number'],
        ['batchId', 'batch_id'],
        ['sectionId', 'section_id'],
      ] as const) {
        if (out[c]) problems.push({ path: k, message: 'only students have this' });
      }
    }
    if (problems.length > 0) throw new InvalidProfileValueError(problems);
    if (Object.keys(out).length === 0) throw new NothingToUpdateError();
    return out;
  }

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapProfileDbError(err) ?? err;
    }
  }

  async function move(
    ctx: RequestContext,
    userIds: string[],
    sectionId: string,
  ): Promise<MoveOutcome> {
    const tenantId = tenantFor(ctx, 'profile.manage');
    const r = await guarded(() =>
      db.withTenant(tenantId, (tx) =>
        profilesRepo.moveToSection(tx, tenantId, userIds, sectionId, ctx.userId),
      ),
    );
    if (!r.targetFound) throw new SectionNotFoundError();
    const done = new Set([...r.movedIds, ...r.unchangedIds]);
    return {
      moved: r.movedIds.length,
      unchanged: r.unchangedIds.length,
      skipped: userIds.filter((u) => !done.has(u)),
    };
  }

  return {
    /** GET /members/:userId/profile (institution admin). */
    async get(ctx: RequestContext, userId: string): Promise<Row> {
      const tenantId = tenantFor(ctx, 'profile.manage');
      const r = await db.withTenant(tenantId, (tx) => profilesRepo.find(tx, tenantId, userId));
      if (!r.memberFound) throw new MemberNotFoundError();
      if (!r.profile) throw new ProfileNotFoundError();
      return r.profile;
    },

    /** GET /me/profile: the caller's own profile. */
    async getOwn(ctx: RequestContext): Promise<Row> {
      const tenantId = tenantFor(ctx, 'profile.read_own');
      const r = await db.withTenant(tenantId, (tx) => profilesRepo.find(tx, tenantId, ctx.userId));
      if (!r.profile) throw new ProfileNotFoundError();
      return r.profile;
    },

    /** PATCH /members/:userId/profile: creates the profile or changes the sent fields (audited). */
    async update(ctx: RequestContext, userId: string, input: ProfileInput): Promise<Row> {
      const tenantId = tenantFor(ctx, 'profile.manage');
      const values = toValues(input);
      const r = await guarded(() =>
        db.withTenant(tenantId, (tx) =>
          profilesRepo.upsert(tx, tenantId, userId, newId(), values, {
            id: newId(),
            actorUserId: ctx.userId,
          }),
        ),
      );
      if (!r.memberFound || !r.profile) throw new MemberNotFoundError();
      return r.profile;
    },

    /** POST /members/:userId/profile/section: one student to a section of their own batch. */
    async moveOne(ctx: RequestContext, userId: string, sectionId: string): Promise<MoveOutcome> {
      return move(ctx, [userId], sectionId);
    },

    /** POST /sections/move: up to 500 students at once; the others are reported as skipped. */
    moveMany: move,
  };
}
export type ProfilesService = ReturnType<typeof createProfilesService>;
