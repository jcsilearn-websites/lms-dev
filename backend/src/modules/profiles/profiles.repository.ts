import { type SQL, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { auditInsertFrom } from '../audit';

// SQL only. Every function receives the transaction from the service and sends ONE statement (data-
// modifying CTEs: lock + change + audit entry). Rows come back as JSON with snake_case column names.

export type Row = Record<string, unknown>;

export interface AuditStamp {
  id: string;
  actorUserId: string;
}

/** Profile columns a PATCH may set, keyed by column name (only the keys present are written). */
export type ProfileValues = Partial<
  Record<
    | 'profile_type'
    | 'phone'
    | 'designation'
    | 'register_number'
    | 'employee_id'
    | 'department_id'
    | 'batch_id'
    | 'section_id',
    string | null
  >
>;

const raw = (s: string) => sql.raw(s);

const PROFILE_COLS =
  'id, tenant_id, membership_id, profile_type, phone, designation, register_number, employee_id, batch_id, section_id, department_id, created_at, updated_at';
const PROFILE_COLS_X = PROFILE_COLS.split(', ')
  .map((c) => `x.${c}`)
  .join(', ');

/** The display shape: the profile with the codes of its department / program / batch / section (the program is derived through the batch). */
const displayFrom = (profile: SQL, userId: SQL) => sql`
  SELECT ${userId} AS user_id, p.profile_type, p.phone, p.designation, p.register_number, p.employee_id,
         p.department_id, d.code AS department_code, pr.id AS program_id, pr.code AS program_code, pr.name AS program_name, p.batch_id,
         b.admission_year, b.graduation_year, p.section_id, s.code AS section_code,
         p.created_at, p.updated_at
    FROM ${profile} p
    LEFT JOIN lms.departments d ON d.tenant_id = p.tenant_id AND d.id = p.department_id
    LEFT JOIN lms.batches b ON b.tenant_id = p.tenant_id AND b.id = p.batch_id
    LEFT JOIN lms.programs pr ON pr.tenant_id = b.tenant_id AND pr.id = b.program_id
    LEFT JOIN lms.sections s ON s.tenant_id = p.tenant_id AND s.id = p.section_id`;

export interface MoveResult {
  targetFound: boolean;
  movedIds: string[];
  unchangedIds: string[];
}

export function createProfilesRepository() {
  return {
    /** The member's profile (display shape) and whether the member exists, in ONE statement. */
    async find(
      tx: Executor,
      tenantId: string,
      userId: string,
    ): Promise<{ memberFound: boolean; profile: Row | null }> {
      const res = await tx.execute(sql`
        SELECT EXISTS (SELECT 1 FROM lms.tenant_memberships m
                        WHERE m.tenant_id = ${tenantId}::uuid AND m.user_id = ${userId}::uuid) AS member_found,
               (SELECT to_jsonb(r) FROM (
                  ${displayFrom(
                    sql`(SELECT p.* FROM lms.member_profiles p JOIN lms.tenant_memberships m
                           ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
                          WHERE p.tenant_id = ${tenantId}::uuid AND m.user_id = ${userId}::uuid)`,
                    sql`${userId}::uuid`,
                  )}
                ) r) AS row`);
      const r = res.rows[0];
      return { memberFound: r?.member_found === true, profile: (r?.row as Row | null) ?? null };
    },

    /**
     * Creates the profile when the member has none, otherwise changes the given columns: one statement.
     * `profile_type` must be among the values when it is a creation (NOT NULL otherwise: 23502).
     */
    async upsert(
      tx: Executor,
      tenantId: string,
      userId: string,
      newId: string,
      values: ProfileValues,
      audit: AuditStamp,
    ): Promise<{ memberFound: boolean; profile: Row | null }> {
      const set = sql.join(
        Object.entries(values).map(
          ([c, v]) => sql`${raw(c)} = ${c === 'profile_type' ? sql`${v}::lms.profile_type` : v}`,
        ),
        sql`, `,
      );
      const v = (c: keyof ProfileValues) => values[c] ?? null;
      const created = auditInsertFrom(
        {
          id: audit.id,
          tenantId,
          actorUserId: audit.actorUserId,
          action: 'profile.created',
          targetType: 'profile',
        },
        {
          from: sql`ins`,
          targetId: sql`ins.id::text`,
          metadata: sql`jsonb_build_object('userId', ${userId}::text, 'after', to_jsonb(ins))`,
        },
      );
      const updated = auditInsertFrom(
        {
          id: audit.id,
          tenantId,
          actorUserId: audit.actorUserId,
          action: 'profile.updated',
          targetType: 'profile',
        },
        {
          from: sql`old JOIN upd ON upd.id = old.id`,
          targetId: sql`old.id::text`,
          metadata: sql`jsonb_build_object('userId', ${userId}::text, 'before', to_jsonb(old), 'after', to_jsonb(upd))`,
        },
      );
      const res = await tx.execute(sql`
        WITH m AS (
          SELECT id FROM lms.tenant_memberships WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid
        ), old AS (
          SELECT p.* FROM lms.member_profiles p JOIN m ON p.membership_id = m.id
           WHERE p.tenant_id = ${tenantId}::uuid FOR UPDATE OF p
        ), upd AS (
          UPDATE lms.member_profiles x SET ${set}, updated_at = now() FROM old
           WHERE x.id = old.id RETURNING ${raw(PROFILE_COLS_X)}
        ), ins AS (
          INSERT INTO lms.member_profiles
            (id, tenant_id, membership_id, profile_type, phone, designation, register_number, employee_id,
             department_id, batch_id, section_id)
          SELECT ${newId}::uuid, ${tenantId}::uuid, m.id, ${v('profile_type')}::lms.profile_type,
                 ${v('phone')}::text, ${v('designation')}::text, ${v('register_number')}::text,
                 ${v('employee_id')}::text, ${v('department_id')}::uuid, ${v('batch_id')}::uuid,
                 ${v('section_id')}::uuid
            FROM m WHERE NOT EXISTS (SELECT 1 FROM old)
          RETURNING ${raw(PROFILE_COLS)}
        ), aud_c AS (${created}), aud_u AS (${updated})
        SELECT EXISTS (SELECT 1 FROM m) AS member_found,
               (SELECT to_jsonb(r) FROM (
                  ${displayFrom(sql`(SELECT * FROM upd UNION ALL SELECT * FROM ins)`, sql`${userId}::uuid`)}
                ) r) AS row`);
      const r = res.rows[0];
      return { memberFound: r?.member_found === true, profile: (r?.row as Row | null) ?? null };
    },

    /**
     * Moves STUDENTS to a section of THEIR OWN batch, in one statement, and audits every move (one entry
     * per student, before/after). Anyone who is not a student of that batch is left alone.
     */
    async moveToSection(
      tx: Executor,
      tenantId: string,
      userIds: string[],
      sectionId: string,
      actorUserId: string,
    ): Promise<MoveResult> {
      const ids = `{${userIds.join(',')}}`;
      const audit = auditInsertFrom(
        {
          id: sql`lms.uuid_v7()`,
          tenantId,
          actorUserId,
          action: 'profile.section_moved',
          targetType: 'profile',
        },
        {
          from: sql`old JOIN upd ON upd.id = old.id`,
          targetId: sql`old.id::text`,
          metadata: sql`jsonb_build_object('userId', old.user_id,
            'before', jsonb_build_object('sectionId', old.section_id),
            'after', jsonb_build_object('sectionId', ${sectionId}::text))`,
        },
      );
      const res = await tx.execute(sql`
        WITH target AS (
          SELECT s.id, s.batch_id FROM lms.sections s
           WHERE s.tenant_id = ${tenantId}::uuid AND s.id = ${sectionId}::uuid AND s.archived_at IS NULL
        ), old AS (
          SELECT p.id, p.section_id, m.user_id
            FROM lms.member_profiles p
            JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
            JOIN target t ON t.batch_id = p.batch_id
           WHERE p.tenant_id = ${tenantId}::uuid AND p.profile_type = 'student'
             AND m.user_id = ANY(${ids}::uuid[])
             FOR UPDATE OF p
        ), upd AS (
          UPDATE lms.member_profiles x SET section_id = ${sectionId}::uuid, updated_at = now() FROM old
           WHERE x.id = old.id AND x.section_id IS DISTINCT FROM ${sectionId}::uuid
          RETURNING x.id
        ), aud AS (${audit})
        SELECT EXISTS (SELECT 1 FROM target) AS target_found,
               COALESCE((SELECT array_agg(old.user_id) FROM old JOIN upd ON upd.id = old.id), '{}') AS moved_ids,
               COALESCE((SELECT array_agg(old.user_id) FROM old
                          WHERE old.section_id IS NOT DISTINCT FROM ${sectionId}::uuid), '{}') AS unchanged_ids`);
      const r = res.rows[0];
      return {
        targetFound: r?.target_found === true,
        movedIds: (r?.moved_ids as string[]) ?? [],
        unchangedIds: (r?.unchanged_ids as string[]) ?? [],
      };
    },
  };
}
export type ProfilesRepository = ReturnType<typeof createProfilesRepository>;
