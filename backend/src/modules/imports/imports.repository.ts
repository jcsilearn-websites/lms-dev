import { type SQL, sql } from 'drizzle-orm';
import { pgArray } from '../../core/pg-array';
import type { Executor } from '../../db/client';
import { auditInsertFrom } from '../audit';
import type { CellError, ImportKind, ParsedRow, StagedField } from './imports.csv';

// SQL only. Staging, validation and processing are SET-BASED: a batch of rows is one UNNEST insert, the
// whole file is validated by one UPDATE, and a batch of 500 rows is applied by one statement of
// data-modifying CTEs (never a query per row). Rows come back as JSON with snake_case names.

export type Row = Record<string, unknown>;

export interface AuditStamp {
  id: string;
  /** null = the system (the worker has no signed-in actor) */
  actorUserId: string | null;
}

const raw = (s: string) => sql.raw(s);

const JOB_COLS = `id, kind, file_name, status, update_existing, skip_invalid, total_rows, valid_rows,
  invalid_rows, processed_rows, skipped_rows, failed_rows, created_members, updated_members, error,
  created_at, confirmed_at, started_at, finished_at, rows_purged_at`;
const JOB_COLS_X = JOB_COLS.split(',')
  .map((c) => `x.${c.trim()}`)
  .join(', ');

function jobAudit(tenantId: string, a: AuditStamp, action: string, from: SQL, metadata: SQL): SQL {
  return auditInsertFrom(
    { id: a.id, tenantId, actorUserId: a.actorUserId, action, targetType: 'import' },
    { from, targetId: sql`j.id::text`, metadata },
  );
}

const jobSummary = sql`jsonb_build_object('fileName', j.file_name, 'kind', j.kind, 'total', j.total_rows,
  'valid', j.valid_rows, 'invalid', j.invalid_rows, 'processed', j.processed_rows,
  'skipped', j.skipped_rows, 'failed', j.failed_rows, 'created', j.created_members,
  'updated', j.updated_members)`;

/** What one processing batch did. */
export interface BatchResult {
  picked: number;
}

export interface ConfirmResult {
  found: boolean;
  /** the job BEFORE the change (null when not found) */
  before: Row | null;
  /** the job after it, or null when the confirm was refused */
  after: Row | null;
}

export function createImportsRepository() {
  return {
    async createJob(
      tx: Executor,
      j: { id: string; tenantId: string; kind: ImportKind; fileName: string; userId: string },
    ): Promise<void> {
      await tx.execute(
        sql`INSERT INTO lms.import_jobs (id, tenant_id, kind, file_name, status, created_by_user_id)
            VALUES (${j.id}::uuid, ${j.tenantId}::uuid, ${j.kind}::lms.import_kind, ${j.fileName}::text,
                    'parsing', ${j.userId}::uuid)`,
      );
    },

    /** A batch of parsed rows in ONE statement (arrays + UNNEST). */
    async stageRows(
      tx: Executor,
      tenantId: string,
      importId: string,
      rows: readonly ParsedRow[],
    ): Promise<void> {
      const col = (f: StagedField) => pgArray(rows.map((r) => r.staged[f] ?? null));
      await tx.execute(sql`
        INSERT INTO lms.import_rows
          (tenant_id, import_id, row_number, status, raw, email, full_name, register_number, employee_id,
           department_code, program_code, batch_label, section_code, phone, errors)
        SELECT ${tenantId}::uuid, ${importId}::uuid, u.rn, 'pending', u.raw::jsonb, u.email, u.full_name,
               u.reg, u.emp, u.dept, u.prog, u.batch, u.section, u.phone, u.errs::jsonb
          FROM unnest(
            ${`{${rows.map((r) => r.rowNumber).join(',')}}`}::int[],
            ${pgArray(rows.map((r) => JSON.stringify(r.raw)))}::text[],
            ${col('email')}::text[], ${col('fullName')}::text[], ${col('registerNumber')}::text[],
            ${col('employeeId')}::text[], ${col('departmentCode')}::text[], ${col('programCode')}::text[],
            ${col('batchLabel')}::text[], ${col('sectionCode')}::text[], ${col('phone')}::text[],
            ${pgArray(rows.map((r) => JSON.stringify(r.errors satisfies CellError[])))}::text[]
          ) AS u(rn, raw, email, full_name, reg, emp, dept, prog, batch, section, phone, errs)`);
    },

    /**
     * The dry run: validates EVERY staged row of the import with one set-based UPDATE (formats, unknown
     * codes, duplicates inside the file, duplicates against the college, existing members with a different
     * register number) and resolves the department / program / batch / section ids. Reads the real tables,
     * writes only import_rows.
     */
    async validate(
      tx: Executor,
      tenantId: string,
      importId: string,
      kind: ImportKind,
    ): Promise<void> {
      const t = sql`${tenantId}::uuid`;
      const i = sql`${importId}::uuid`;
      const students = kind === 'students';
      await tx.execute(sql`
        WITH r AS (
          SELECT *, ctid AS rid FROM lms.import_rows WHERE tenant_id = ${t} AND import_id = ${i}
        ), ref AS (
          SELECT r.row_number, r.rid, r.department_code, r.program_code, r.batch_label, r.section_code,
                 d.id AS department_id, pr.id AS program_id, b.id AS batch_id, s.id AS section_id
            FROM r
            LEFT JOIN lms.departments d ON d.tenant_id = ${t} AND d.code = upper(r.department_code)
                                       AND d.archived_at IS NULL
            LEFT JOIN lms.programs pr ON pr.tenant_id = ${t} AND pr.department_id = d.id
                                     AND pr.code = upper(r.program_code) AND pr.archived_at IS NULL
            LEFT JOIN lms.batches b ON b.tenant_id = ${t} AND b.program_id = pr.id
                                   AND (b.admission_year::text || '-' || b.graduation_year::text) = r.batch_label
                                   AND b.archived_at IS NULL
            LEFT JOIN lms.sections s ON s.tenant_id = ${t} AND s.batch_id = b.id
                                    AND s.code = upper(r.section_code) AND s.archived_at IS NULL
        ), dup AS (
          SELECT r.row_number, r.email, r.register_number, r.employee_id,
                 r.row_number > min(r.row_number) OVER (PARTITION BY r.email) AS dup_email,
                 r.row_number > min(r.row_number) OVER (PARTITION BY r.register_number) AS dup_reg,
                 r.row_number > min(r.row_number) OVER (PARTITION BY r.employee_id) AS dup_emp
            FROM r
        ), existing AS (
          SELECT r.row_number, r.register_number, r.employee_id, p.profile_type AS p_type,
                 p.register_number AS p_reg, p.employee_id AS p_emp
            FROM r
            JOIN lms.users u ON u.email = r.email
            JOIN lms.tenant_memberships m ON m.tenant_id = ${t} AND m.user_id = u.id
            -- the unique key (tenant_id, membership_id): one lookup per row
            LEFT JOIN LATERAL (
              SELECT q.profile_type, q.register_number, q.employee_id FROM lms.member_profiles q
               WHERE q.tenant_id = ${t} AND q.membership_id = m.id
            ) p ON true
        ), hold AS MATERIALIZED (
          -- the members that already hold one of the file's ${students ? sql`register numbers` : sql`employee ids`}, found with a window
          -- function over (the file's keys + the college's keys): sort based, so the work does not depend on the
          -- planner's idea of table sizes. Every index plan tried here (correlated EXISTS, ANY(array), LATERAL
          -- probes) fell back to scanning the college's profiles once per file row whenever the planner had no
          -- statistics for the tenant - the state of every college during its first bulk load.
          SELECT w.key, w.membership_id FROM (
            SELECT a.key, a.membership_id, a.src,
                   count(*) FILTER (WHERE a.src = 'n') OVER (PARTITION BY a.key) AS wanted
              FROM (
                SELECT r.${students ? sql`register_number` : sql`employee_id`} AS key, NULL::uuid AS membership_id, 'n' AS src
                  FROM r WHERE r.${students ? sql`register_number` : sql`employee_id`} IS NOT NULL
                UNION ALL
                SELECT p.${students ? sql`register_number` : sql`employee_id`}, p.membership_id, 'o'
                  FROM lms.member_profiles p
                 WHERE p.tenant_id = ${t} AND p.${students ? sql`register_number` : sql`employee_id`} IS NOT NULL
              ) a
          ) w WHERE w.src = 'o' AND w.wanted > 0
        ), ekey AS (
          SELECT h.key, u.email
            FROM hold h
            JOIN lms.tenant_memberships m ON m.tenant_id = ${t} AND m.id = h.membership_id
            JOIN lms.users u ON u.id = m.user_id
        ), taken AS (
          -- a file row clashes when SOME existing holder of its key has another email. Window functions over
          -- file rows + holders: sort based, linear whatever the planner estimates (no join to misjudge)
          SELECT k.row_number FROM (
            SELECT a.row_number, a.src,
                   count(*) FILTER (WHERE a.src = 'o') OVER (PARTITION BY a.key) AS holders,
                   count(*) FILTER (WHERE a.src = 'o') OVER (PARTITION BY a.key, a.email) AS same_email
              FROM (
                SELECT r.row_number, 'n' AS src, r.${students ? sql`register_number` : sql`employee_id`} AS key, r.email FROM r
                 WHERE r.${students ? sql`register_number` : sql`employee_id`} IS NOT NULL
                UNION ALL
                SELECT NULL::int, 'o', e.key, e.email FROM ekey e
              ) a
          ) k WHERE k.src = 'n' AND k.holders > k.same_email
        
        ), errs AS (
          SELECT row_number, 'email' AS col, 'is required' AS msg FROM r WHERE email IS NULL
          UNION ALL SELECT row_number, 'email', 'is not a valid email address' FROM r
            WHERE email IS NOT NULL AND (email !~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$' OR length(email) > 320)
          UNION ALL SELECT d.row_number, 'email', 'appears earlier in the file' FROM dup d
            WHERE d.dup_email AND d.email IS NOT NULL
          UNION ALL SELECT row_number, 'full_name', 'is required' FROM r WHERE full_name IS NULL
          UNION ALL SELECT row_number, 'full_name', 'is too long (at most 200 characters)' FROM r WHERE length(full_name) > 200
          UNION ALL SELECT row_number, 'department_code', 'is required' FROM r WHERE department_code IS NULL
          UNION ALL SELECT ref.row_number, 'department_code', 'unknown or archived department_code' FROM ref
            WHERE ref.department_code IS NOT NULL AND ref.department_id IS NULL
          UNION ALL SELECT e.row_number, 'email', 'is already a member with a ' || e.p_type::text || ' profile' FROM existing e
            WHERE e.p_type IS NOT NULL AND e.p_type <> ${students ? sql`'student'` : sql`'faculty'`}::lms.profile_type
              AND NOT (${!students}::boolean AND e.p_type = 'staff')
          ${
            students
              ? sql`
          UNION ALL SELECT row_number, 'register_number', 'is required' FROM r WHERE register_number IS NULL
          UNION ALL SELECT row_number, 'register_number', 'may contain letters, digits and . / _ - only (at most 40)' FROM r
            WHERE register_number IS NOT NULL AND register_number !~ '^[A-Za-z0-9][A-Za-z0-9./_-]{0,39}$'
          UNION ALL SELECT d.row_number, 'register_number', 'appears earlier in the file' FROM dup d
            WHERE d.dup_reg AND d.register_number IS NOT NULL
          UNION ALL SELECT k.row_number, 'register_number', 'is already used by another member' FROM taken k
          UNION ALL SELECT e.row_number, 'register_number',
                 'this email is already a member with register number ' || e.p_reg FROM existing e
            WHERE e.p_reg IS NOT NULL AND e.register_number IS NOT NULL AND e.p_reg <> e.register_number
          UNION ALL SELECT row_number, 'program_code', 'is required' FROM r WHERE program_code IS NULL
          UNION ALL SELECT ref.row_number, 'program_code', 'unknown or archived program_code for this department' FROM ref
            WHERE ref.program_code IS NOT NULL AND ref.department_id IS NOT NULL AND ref.program_id IS NULL
          UNION ALL SELECT row_number, 'batch', 'is required' FROM r WHERE batch_label IS NULL
          UNION ALL SELECT row_number, 'batch', 'must look like 2023-2027' FROM r
            WHERE batch_label IS NOT NULL AND batch_label !~ '^[0-9]{4}-[0-9]{4}$'
          UNION ALL SELECT ref.row_number, 'batch', 'unknown or archived batch for this program' FROM ref
            WHERE ref.batch_label ~ '^[0-9]{4}-[0-9]{4}$' AND ref.program_id IS NOT NULL AND ref.batch_id IS NULL
          UNION ALL SELECT row_number, 'section', 'is required' FROM r WHERE section_code IS NULL
          UNION ALL SELECT ref.row_number, 'section', 'unknown or archived section for this batch' FROM ref
            WHERE ref.section_code IS NOT NULL AND ref.batch_id IS NOT NULL AND ref.section_id IS NULL`
              : sql`
          UNION ALL SELECT row_number, 'employee_id', 'is required' FROM r WHERE employee_id IS NULL
          UNION ALL SELECT row_number, 'employee_id', 'may contain letters, digits and . / _ - only (at most 40)' FROM r
            WHERE employee_id IS NOT NULL AND employee_id !~ '^[A-Za-z0-9][A-Za-z0-9./_-]{0,39}$'
          UNION ALL SELECT d.row_number, 'employee_id', 'appears earlier in the file' FROM dup d
            WHERE d.dup_emp AND d.employee_id IS NOT NULL
          UNION ALL SELECT k.row_number, 'employee_id', 'is already used by another member' FROM taken k
          UNION ALL SELECT e.row_number, 'employee_id',
                 'this email is already a member with employee id ' || e.p_emp FROM existing e
            WHERE e.p_emp IS NOT NULL AND e.employee_id IS NOT NULL AND e.p_emp <> e.employee_id`
          }
          UNION ALL SELECT row_number, 'phone', 'is not a valid phone number' FROM r
            WHERE phone IS NOT NULL AND phone !~ '^\\+?[0-9][0-9 -]{5,18}$'
        ), agg AS (
          SELECT row_number,
                 jsonb_agg(jsonb_build_object('column', col, 'message', msg) ORDER BY col, msg) AS errs
            FROM errs GROUP BY row_number
        )
        UPDATE lms.import_rows x
           SET errors = x.errors || COALESCE(agg.errs, '[]'::jsonb),
               status = CASE WHEN jsonb_array_length(x.errors || COALESCE(agg.errs, '[]'::jsonb)) = 0
                             THEN 'valid'::lms.import_row_status ELSE 'invalid'::lms.import_row_status END,
               department_id = ref.department_id, program_id = ref.program_id,
               batch_id = ref.batch_id, section_id = ref.section_id
          FROM ref LEFT JOIN agg ON agg.row_number = ref.row_number
         WHERE x.tenant_id = ${t} AND x.import_id = ${i} AND x.ctid = ref.rid`);
    },

    /** Closes the dry run: the counts, status 'validated', and the audit entry (who, file, counts). */
    async finalizeUpload(
      tx: Executor,
      tenantId: string,
      importId: string,
      audit: AuditStamp,
    ): Promise<Row> {
      const aud = jobAudit(tenantId, audit, 'import.uploaded', sql`upd j`, jobSummary);
      const res = await tx.execute(sql`
        WITH c AS (
          SELECT count(*)::int AS total,
                 (count(*) FILTER (WHERE status = 'valid'))::int AS valid,
                 (count(*) FILTER (WHERE status = 'invalid'))::int AS invalid
            FROM lms.import_rows WHERE tenant_id = ${tenantId}::uuid AND import_id = ${importId}::uuid
        ), upd AS (
          UPDATE lms.import_jobs x
             SET status = 'validated', total_rows = c.total, valid_rows = c.valid, invalid_rows = c.invalid,
                 updated_at = now()
            FROM c WHERE x.tenant_id = ${tenantId}::uuid AND x.id = ${importId}::uuid
          RETURNING ${raw(JOB_COLS_X)}
        ), aud AS (${aud})
        SELECT to_jsonb(upd) AS row FROM upd`);
      return res.rows[0]?.row as Row;
    },

    async getJob(tx: Executor, tenantId: string, id: string): Promise<Row | null> {
      const res = await tx.execute(
        sql`SELECT to_jsonb(r) AS row FROM (SELECT ${raw(JOB_COLS)} FROM lms.import_jobs
             WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid) r`,
      );
      return (res.rows[0]?.row as Row | undefined) ?? null;
    },

    /** Newest first (UUIDv7 ids are time-ordered); keyset on the id. */
    async listJobs(
      tx: Executor,
      tenantId: string,
      page: { limit: number; after?: string | undefined },
    ): Promise<Row[]> {
      const res = await tx.execute(sql`
        SELECT to_jsonb(r) AS row FROM (
          SELECT ${raw(JOB_COLS)} FROM lms.import_jobs
           WHERE tenant_id = ${tenantId}::uuid ${page.after ? sql`AND id < ${page.after}::uuid` : sql``}
           ORDER BY id DESC LIMIT ${page.limit}
        ) r ORDER BY r.id DESC`);
      return res.rows.map((r) => r.row as Row);
    },

    /** Staged rows of an import, by row number (the review of the dry run, and the error report). */
    async rowsPage(
      tx: Executor,
      tenantId: string,
      importId: string,
      f: { statuses?: string[] | undefined; after: number; limit: number },
    ): Promise<Row[]> {
      const res = await tx.execute(sql`
        SELECT to_jsonb(r) AS row FROM (
          SELECT row_number, status, raw, errors, result FROM lms.import_rows
           WHERE tenant_id = ${tenantId}::uuid AND import_id = ${importId}::uuid AND row_number > ${f.after}
             ${f.statuses ? sql`AND status = ANY(${`{${f.statuses.join(',')}}`}::lms.import_row_status[])` : sql``}
           ORDER BY row_number LIMIT ${f.limit}
        ) r ORDER BY r.row_number`);
      return res.rows.map((r) => r.row as Row);
    },

    /**
     * Confirm in ONE statement: the state check, validated -> queued, the background job (a row in the
     * queue, in this same transaction) and the audit entry. Refused (after = null) unless the import is
     * validated, has valid rows and either no invalid rows or skipInvalid. A second running import of the
     * tenant violates import_jobs_one_running (23505).
     */
    async confirm(
      tx: Executor,
      tenantId: string,
      id: string,
      o: { updateExisting: boolean; skipInvalid: boolean; jobId: string; maxAttempts: number },
      audit: AuditStamp,
    ): Promise<ConfirmResult> {
      const aud = jobAudit(
        tenantId,
        audit,
        'import.confirmed',
        sql`upd j`,
        sql`${jobSummary} || jsonb_build_object('updateExisting', j.update_existing, 'skipInvalid', j.skip_invalid)`,
      );
      const res = await tx.execute(sql`
        WITH old AS (
          SELECT ${raw(JOB_COLS)} FROM lms.import_jobs
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE
        ), upd AS (
          UPDATE lms.import_jobs x
             SET status = 'queued', update_existing = ${o.updateExisting}::boolean,
                 skip_invalid = ${o.skipInvalid}::boolean, confirmed_at = now(), updated_at = now()
            FROM old
           WHERE x.id = old.id AND old.status = 'validated' AND old.valid_rows > 0
             AND (old.invalid_rows = 0 OR ${o.skipInvalid}::boolean)
          RETURNING ${raw(JOB_COLS_X)}
        ), enq AS (
          INSERT INTO lms.jobs (id, queue, tenant_id, payload, max_attempts, singleton_key)
          SELECT ${o.jobId}::uuid, 'imports.process', ${tenantId}::uuid,
                 jsonb_build_object('importId', upd.id), ${o.maxAttempts}::int, 'import:' || upd.id::text
            FROM upd
          RETURNING 1
        ), aud AS (${aud})
        SELECT (SELECT to_jsonb(old) FROM old) AS before, (SELECT to_jsonb(upd) FROM upd) AS after`);
      const r = res.rows[0];
      return {
        found: r?.before != null,
        before: (r?.before as Row | null) ?? null,
        after: (r?.after as Row | null) ?? null,
      };
    },

    /** validated -> cancelled (the staged rows wait for the retention purge). */
    async cancel(
      tx: Executor,
      tenantId: string,
      id: string,
      audit: AuditStamp,
    ): Promise<{ before: Row | null; after: Row | null }> {
      const aud = jobAudit(tenantId, audit, 'import.cancelled', sql`upd j`, jobSummary);
      const res = await tx.execute(sql`
        WITH old AS (
          SELECT ${raw(JOB_COLS)} FROM lms.import_jobs
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE
        ), upd AS (
          UPDATE lms.import_jobs x SET status = 'cancelled', finished_at = now(), updated_at = now()
            FROM old WHERE x.id = old.id AND old.status = 'validated'
          RETURNING ${raw(JOB_COLS_X)}
        ), aud AS (${aud})
        SELECT (SELECT to_jsonb(old) FROM old) AS before, (SELECT to_jsonb(upd) FROM upd) AS after`);
      const r = res.rows[0];
      return { before: (r?.before as Row | null) ?? null, after: (r?.after as Row | null) ?? null };
    },

    /** queued/processing -> processing (idempotent: a resumed job finds it already processing). */
    async markProcessing(
      tx: Executor,
      tenantId: string,
      id: string,
    ): Promise<{ kind: ImportKind; updateExisting: boolean } | null> {
      const res = await tx.execute(sql`
        UPDATE lms.import_jobs SET status = 'processing', started_at = COALESCE(started_at, now()),
               updated_at = now()
         WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND status IN ('queued', 'processing')
        RETURNING kind, update_existing`);
      const r = res.rows[0];
      return r ? { kind: r.kind as ImportKind, updateExisting: r.update_existing === true } : null;
    },

    /**
     * Applies the next batch of VALID rows in ONE statement and recomputes the counts in a second one:
     *   users (set-based, new accounts only) -> memberships (pending, role member) -> profiles -> invite
     *   jobs (queue rows, staggered to INVITE_RATE_PER_SECOND; the mails are sent by the queue, never here)
     *   -> the row results. Row status flips in the same statement as the writes, so a crash or a retry
     *   only ever sees rows that are still 'valid': nothing is applied twice.
     * Returns how many rows the batch picked (0 = nothing left).
     */
    async processBatch(
      tx: Executor,
      o: {
        tenantId: string;
        importId: string;
        kind: ImportKind;
        updateExisting: boolean;
        batchSize: number;
        ratePerSecond: number;
        userIds: string[];
        membershipIds: string[];
        profileIds: string[];
      },
    ): Promise<BatchResult> {
      const t = sql`${o.tenantId}::uuid`;
      const i = sql`${o.importId}::uuid`;
      const students = o.kind === 'students';
      const arr = (a: string[]) => sql`${pgArray(a)}::uuid[]`;
      const res = await tx.execute(sql`
        WITH job AS (
          SELECT COALESCE(started_at, now()) AS started_at FROM lms.import_jobs
           WHERE tenant_id = ${t} AND id = ${i}
        ), picked AS (
          SELECT r.ctid AS rid, r.row_number, r.email, r.full_name, r.register_number, r.employee_id,
                 r.phone, r.department_id, r.batch_id, r.section_id
            FROM lms.import_rows r
           WHERE r.tenant_id = ${t} AND r.import_id = ${i} AND r.status = 'valid'
           ORDER BY r.row_number LIMIT ${o.batchSize} FOR UPDATE
        ), batch AS (
          SELECT picked.*, row_number() OVER (ORDER BY picked.row_number) AS ord FROM picked
        ), u AS (
          SELECT * FROM lms.import_ensure_users(${t}, ${i}, ${arr(o.userIds)},
            (SELECT array_agg(email ORDER BY row_number) FROM batch),
            (SELECT array_agg(full_name ORDER BY row_number) FROM batch))
        ), taken AS MATERIALIZED (
          -- the existing holders of this batch's ${students ? sql`register numbers` : sql`employee ids`} (a student file has no employee ids
          -- and a faculty file no register numbers: only its own key can clash). Sort based like the dry run
          -- (see \`hold\` in validate): independent of what the planner believes about the tenant's size.
          SELECT w.key, w.membership_id FROM (
            SELECT a.key, a.membership_id, a.src,
                   count(*) FILTER (WHERE a.src = 'n') OVER (PARTITION BY a.key) AS wanted
              FROM (
                SELECT b.${students ? sql`register_number` : sql`employee_id`} AS key, NULL::uuid AS membership_id, 'n' AS src
                  FROM batch b WHERE b.${students ? sql`register_number` : sql`employee_id`} IS NOT NULL
                UNION ALL
                SELECT q.${students ? sql`register_number` : sql`employee_id`}, q.membership_id, 'o'
                  FROM lms.member_profiles q
                 WHERE q.tenant_id = ${t} AND q.${students ? sql`register_number` : sql`employee_id`} IS NOT NULL
              ) a
          ) w WHERE w.src = 'o' AND w.wanted > 0
        ), ctx AS (
          SELECT b.*, u.r_user_id AS user_id, m.id AS m_id, m.status AS m_status,
                 -- unique key (tenant_id, membership_id): a lookup per row, never a join the planner can misjudge
                 (SELECT p.id FROM lms.member_profiles p
                   WHERE p.tenant_id = ${t} AND p.membership_id = m.id) AS p_id,
                 EXISTS (SELECT 1 FROM taken k
                          WHERE k.key = b.${students ? sql`register_number` : sql`employee_id`}
                            AND k.membership_id IS DISTINCT FROM m.id) AS conflict,
                 (EXISTS (SELECT 1 FROM lms.departments d WHERE d.tenant_id = ${t} AND d.id = b.department_id
                            AND d.archived_at IS NULL)
                  ${
                    students
                      ? sql`AND EXISTS (SELECT 1 FROM lms.batches bb WHERE bb.tenant_id = ${t} AND bb.id = b.batch_id
                            AND bb.archived_at IS NULL)
                        AND EXISTS (SELECT 1 FROM lms.sections ss WHERE ss.tenant_id = ${t} AND ss.id = b.section_id
                            AND ss.archived_at IS NULL)`
                      : sql``
                  }) AS ref_ok
            FROM batch b
            LEFT JOIN u ON u.r_email = b.email
            LEFT JOIN lms.tenant_memberships m ON m.tenant_id = ${t} AND m.user_id = u.r_user_id
        ), act AS (
          SELECT ctx.*,
                 CASE
                   WHEN user_id IS NULL THEN 'failed_user'
                   WHEN NOT ref_ok THEN 'failed_reference'
                   WHEN conflict THEN 'failed_conflict'
                   WHEN m_status = 'suspended' THEN 'skipped_suspended'
                   WHEN m_id IS NOT NULL AND NOT ${o.updateExisting}::boolean THEN 'skipped_existing'
                   WHEN m_id IS NOT NULL THEN 'updated'
                   ELSE 'created'
                 END AS action
            FROM ctx
        ), ins_m AS (
          INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status)
          SELECT (${arr(o.membershipIds)})[act.ord::int], ${t}, act.user_id, 'member', 'pending'
            FROM act WHERE act.action = 'created'
          ON CONFLICT (tenant_id, user_id) DO NOTHING
          RETURNING id, user_id
        ), ins_p AS (
          INSERT INTO lms.member_profiles
            (id, tenant_id, membership_id, profile_type, phone, register_number, employee_id,
             department_id, batch_id, section_id)
          SELECT (${arr(o.profileIds)})[act.ord::int], ${t}, COALESCE(im.id, act.m_id),
                 ${students ? sql`'student'` : sql`'faculty'`}::lms.profile_type, act.phone,
                 act.register_number, act.employee_id, act.department_id, act.batch_id, act.section_id
            FROM act LEFT JOIN ins_m im ON im.user_id = act.user_id
           WHERE (act.action = 'created' AND im.id IS NOT NULL)
              OR (act.action = 'updated' AND act.p_id IS NULL)
          RETURNING membership_id
        ), upd_p AS (
          UPDATE lms.member_profiles x
             SET phone = COALESCE(a.phone, x.phone),
                 ${
                   students
                     ? sql`register_number = a.register_number, batch_id = a.batch_id, section_id = a.section_id`
                     : sql`employee_id = a.employee_id, department_id = a.department_id`
                 },
                 updated_at = now()
            FROM act a
           WHERE a.action = 'updated' AND a.p_id = x.id AND x.tenant_id = ${t}
             -- reach the profiles through the primary key for THIS batch only (see done below)
             AND x.id = ANY (ARRAY(SELECT p_id FROM act WHERE action = 'updated' AND p_id IS NOT NULL))
          RETURNING x.id
        ), inv AS (
          INSERT INTO lms.jobs (id, queue, tenant_id, payload, run_at, max_attempts, singleton_key)
          SELECT gen_random_uuid(), 'invites.send', ${t},
                 jsonb_build_object('userId', act.user_id, 'membershipId', im.id, 'email', act.email,
                                    'importId', ${o.importId}::text),
                 job.started_at + make_interval(secs => act.row_number::float8 / ${o.ratePerSecond}::float8),
                 5, 'invite:' || im.id::text
            FROM act JOIN ins_m im ON im.user_id = act.user_id CROSS JOIN job
           WHERE act.action = 'created'
          ON CONFLICT (singleton_key) WHERE singleton_key IS NOT NULL DO NOTHING
          RETURNING 1
        ), done AS (
          UPDATE lms.import_rows r
             SET status = CASE act.action
                            WHEN 'created' THEN 'processed' WHEN 'updated' THEN 'processed'
                            WHEN 'skipped_existing' THEN 'skipped' WHEN 'skipped_suspended' THEN 'skipped'
                            ELSE 'failed' END::lms.import_row_status,
                 result = act.action,
                 errors = CASE WHEN act.action LIKE 'failed%'
                               THEN r.errors || jsonb_build_array(jsonb_build_object('column', '', 'message',
                                      CASE act.action
                                        WHEN 'failed_reference' THEN 'the department, batch or section was archived after validation'
                                        WHEN 'failed_conflict' THEN 'the register number or employee id is now used by another member'
                                        ELSE 'the account could not be created' END))
                               ELSE r.errors END
            FROM act
           WHERE r.tenant_id = ${t} AND r.import_id = ${i} AND r.ctid = act.rid
             -- a TID scan of exactly this batch's rows: the planner cannot turn this into a scan of the
             -- whole import (10,000 rows) joined to the batch with a nested loop
             AND r.ctid = ANY (ARRAY(SELECT rid FROM act))
          RETURNING 1
        )
        SELECT (SELECT count(*) FROM batch)::int AS picked,
               (SELECT count(*) FROM done)::int AS done, (SELECT count(*) FROM inv)::int AS invites,
               (SELECT count(*) FROM ins_p)::int AS profiles, (SELECT count(*) FROM upd_p)::int AS updated`);
      const picked = Number(res.rows[0]?.picked ?? 0);

      // totals from the rows themselves (never accumulated): correct after a crash and resume
      await tx.execute(sql`
        UPDATE lms.import_jobs j
           SET processed_rows = c.processed, skipped_rows = c.skipped, failed_rows = c.failed,
               created_members = c.created, updated_members = c.updated, updated_at = now()
          FROM (
            SELECT (count(*) FILTER (WHERE status = 'processed'))::int AS processed,
                   (count(*) FILTER (WHERE status = 'skipped'))::int AS skipped,
                   (count(*) FILTER (WHERE status = 'failed'))::int AS failed,
                   (count(*) FILTER (WHERE result = 'created'))::int AS created,
                   (count(*) FILTER (WHERE result = 'updated'))::int AS updated
              FROM lms.import_rows WHERE tenant_id = ${t} AND import_id = ${i}
          ) c
         WHERE j.tenant_id = ${t} AND j.id = ${i}`);
      return { picked };
    },

    /** processing -> completed | completed_with_errors, with the audit entry (who, file, counts). */
    async finish(
      tx: Executor,
      tenantId: string,
      id: string,
      audit: AuditStamp,
    ): Promise<Row | null> {
      const aud = jobAudit(tenantId, audit, 'import.completed', sql`upd j`, jobSummary);
      const res = await tx.execute(sql`
        WITH upd AS (
          UPDATE lms.import_jobs x
             SET status = CASE WHEN x.failed_rows > 0 OR x.invalid_rows > 0
                               THEN 'completed_with_errors' ELSE 'completed' END::lms.import_status,
                 finished_at = now(), updated_at = now()
           WHERE x.tenant_id = ${tenantId}::uuid AND x.id = ${id}::uuid AND x.status = 'processing'
          RETURNING ${raw(JOB_COLS_X)}
        ), aud AS (${aud})
        SELECT to_jsonb(upd) AS row FROM upd`);
      return (res.rows[0]?.row as Row | undefined) ?? null;
    },

    /** The import gave up (last attempt failed): free the tenant for its next import. */
    async fail(
      tx: Executor,
      tenantId: string,
      id: string,
      message: string,
      audit: AuditStamp,
    ): Promise<void> {
      const aud = jobAudit(
        tenantId,
        audit,
        'import.failed',
        sql`upd j`,
        sql`${jobSummary} || jsonb_build_object('error', j.error)`,
      );
      await tx.execute(sql`
        WITH upd AS (
          UPDATE lms.import_jobs x
             SET status = 'failed', error = left(${message}::text, 1000), finished_at = now(),
                 updated_at = now()
           WHERE x.tenant_id = ${tenantId}::uuid AND x.id = ${id}::uuid AND x.status IN ('queued', 'processing')
          RETURNING ${raw(JOB_COLS_X)}
        ), aud AS (${aud})
        SELECT 1`);
    },

    /** Staged rows older than the retention period (PII), in bounded batches: definer function. */
    async purgeRows(exec: Executor, retentionDays: number, batch: number): Promise<number> {
      const res = await exec.execute(
        sql`SELECT lms.import_purge_rows(${retentionDays}::int, ${batch}::int) AS n`,
      );
      return Number(res.rows[0]?.n ?? 0);
    },

    /** Imports whose queue job is dead: marked failed so the tenant is not blocked forever. */
    async reapDead(exec: Executor): Promise<number> {
      const res = await exec.execute(sql`SELECT lms.import_reap_dead() AS n`);
      return Number(res.rows[0]?.n ?? 0);
    },
  };
}
export type ImportsRepository = ReturnType<typeof createImportsRepository>;
