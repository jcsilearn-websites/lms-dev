import type {
  AssignmentFinalScore,
  AssignmentSettings,
  GradeInput,
  SubmitAssignmentRequest,
} from '../../contracts';
import { can, type Permission, participationsGranting } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { csvLine } from '../../core/csv';
import { BadRequestError, ForbiddenError } from '../../core/errors';
import { safeFileName, uniqueName } from '../../core/filenames';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../../core/pagination';
import {
  cleanFileName,
  extensionOf,
  kindForName,
  type StorageProvider,
  StorageUnavailableError,
  storageKey,
} from '../../core/storage';
import { newId } from '../../core/uuid';
import { type ZipEntry, zipStream } from '../../core/zip';
import type { Database } from '../../db/client';
import { pgConstraint, pgErrorCode } from '../../db/pg-errors';
import { type AccessSpec, assertAccess, OfferingNotFoundError } from '../courses';
import { type FilesService, FileTypeNotAllowedError, StorageUnavailable } from '../files';
import {
  AlreadySubmittedError,
  AssignmentClosedError,
  AssignmentFileNotFoundError,
  AssignmentNotFoundError,
  AssignmentNotOpenError,
  BlockedFileTypeError,
  EmptySubmissionError,
  GradingStartedError,
  InvalidAssignmentSettingsError,
  InvalidGradeError,
  InvalidSubmissionError,
  LearnerNotFoundError,
  NameSortRefusedError,
  NotGradedError,
  RubricArchivedError,
  RubricNotUsableError,
  SubmissionChangedError,
  SubmissionFilesNotReadyError,
  SubmissionFileTooLargeError,
  SubmissionTypeNotAllowedError,
  TooManyFilesError,
} from './assignments.errors';
import type {
  AssignmentsRepository,
  GradeWrite,
  QueueSort,
  Row,
  SettingsPatch,
} from './assignments.repository';

export type { Row } from './assignments.repository';

export interface AssignmentsConfig {
  /** an upload begun before the due date and finalized within this many seconds counts on time */
  graceSeconds: number;
  /** the storage-wide upload limit; an assignment can only lower it */
  maxFileBytes: number;
}
const DEFAULT_CONFIG: AssignmentsConfig = { graceSeconds: 600, maxFileBytes: 100 * 1024 * 1024 };

/**
 * Programs and scripts are refused for assignments whatever the instructor allows (the general allowlist already has none
 * of them; this list is the second lock and names the reason). A ZIP is accepted when the allowlist has it: its content is
 * not inspected (no malware scan yet, see CLAUDE.md), so the instructor's download is always an attachment.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe',
  'dll',
  'bat',
  'cmd',
  'com',
  'msi',
  'scr',
  'pif',
  'cpl',
  'msc',
  'msp',
  'lnk',
  'url',
  'reg',
  'hta',
  'gadget',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'wsf',
  'wsh',
  'jse',
  'js',
  'mjs',
  'cjs',
  'jar',
  'sh',
  'bash',
  'zsh',
  'command',
  'run',
  'bin',
  'elf',
  'so',
  'dylib',
  'app',
  'apk',
  'deb',
  'rpm',
  'dmg',
  'iso',
  'py',
  'pl',
  'rb',
  'php',
  'jsp',
  'asp',
  'aspx',
  'cgi',
  'html',
  'htm',
  'xhtml',
  'svg',
  'xml',
]);

const MAX_QUEUE_CURSOR = 300;

function encodeCursor(c: { sk: string; key: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}
function decodeCursor(raw: string): { sk: string; key: string } {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      v &&
      typeof v === 'object' &&
      typeof (v as { sk: unknown }).sk === 'string' &&
      typeof (v as { key: unknown }).key === 'string' &&
      /^[0-9a-f-]{36}$/i.test((v as { key: string }).key) &&
      raw.length <= MAX_QUEUE_CURSOR
    )
      return v as { sk: string; key: string };
  } catch {
    // falls through
  }
  throw new BadRequestError('invalid_cursor', 'The pagination cursor is not valid');
}

export function createAssignmentsService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  assignmentsRepo: AssignmentsRepository;
  filesService: Pick<FilesService, 'downloadTarget' | 'confirm'>;
  storage: StorageProvider;
  config?: Partial<AssignmentsConfig>;
}) {
  const { db, assignmentsRepo: repo, filesService, storage } = deps;
  const config: AssignmentsConfig = { ...DEFAULT_CONFIG, ...deps.config };

  const spec = (ctx: RequestContext, offeringId: string, permission: Permission): AccessSpec => {
    if (!ctx.tenantId) throw new ForbiddenError();
    return {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      offeringId,
      viewAll: can(ctx, 'course.read'),
      accountAllowed: can(ctx, permission),
      allowedBy: participationsGranting(permission),
    };
  };
  /** when the request reached the server (core/deadline.ts), for the deadline checks of the database functions */
  const arrivalOf = (ctx: RequestContext) =>
    ctx.arrival
      ? { at: new Date(ctx.arrival.atMs), maxAgeSeconds: ctx.arrival.maxAgeSeconds }
      : null;
  const tenantOf = (ctx: RequestContext): string => {
    if (!ctx.tenantId) throw new ForbiddenError();
    return ctx.tenantId;
  };

  async function storageCall<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StorageUnavailableError) throw new StorageUnavailable();
      throw err;
    }
  }

  /** Maps the verdict of a learner function to the answers every offering route gives. */
  function learnerVerdict(r: Row): void {
    switch (r.result) {
      case 'ok':
      case 'confirm_late':
        return;
      case 'no_offering':
        throw new OfferingNotFoundError();
      case 'forbidden':
        throw new ForbiddenError();
      case 'not_open':
        throw new AssignmentNotOpenError();
      case 'closed':
        throw new AssignmentClosedError();
      case 'already_submitted':
        throw new AlreadySubmittedError();
      case 'empty':
        throw new EmptySubmissionError();
      case 'text_not_allowed':
        throw new SubmissionTypeNotAllowedError('text');
      case 'link_not_allowed':
        throw new SubmissionTypeNotAllowedError('link');
      case 'files_not_allowed':
        throw new SubmissionTypeNotAllowedError('files');
      case 'too_many_files':
        throw new TooManyFilesError(r.maxFiles == null ? undefined : Number(r.maxFiles));
      case 'files_not_ready':
        throw new SubmissionFilesNotReadyError();
      case 'file_too_large':
        throw new SubmissionFileTooLargeError(Number(r.maxMb));
      case 'text_too_long':
        throw new InvalidSubmissionError('The text is too long (at most 50,000 characters)');
      case 'invalid_link':
        throw new InvalidSubmissionError('The link must start with http:// or https://');
      default:
        throw new AssignmentNotFoundError();
    }
  }

  /** The read of an instructor-side statement: access first (404 / 403), then "is there such an assignment". */
  function staff<T extends { acc: unknown; found: boolean }>(r: T): T {
    assertAccess(r.acc as never);
    if (!r.found) throw new AssignmentNotFoundError();
    return r;
  }

  /** Runs a class statement; the first time it also creates the random keys (then it reads again, once). */
  async function withKeys<T extends { missing: number }>(
    a: AccessSpec,
    itemId: string,
    read: (tx: Parameters<Parameters<typeof db.withTenant>[1]>[0]) => Promise<T>,
  ): Promise<T> {
    return db.withTenant(a.tenantId, async (tx) => {
      let r = await read(tx);
      if (r.missing > 0) {
        await repo.ensureLearners(tx, a, itemId);
        r = await read(tx);
      }
      return r;
    });
  }

  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

  return {
    // ================================================================ configuration
    async config(ctx: RequestContext, offeringId: string, itemId: string) {
      const a = spec(ctx, offeringId, 'assignment.manage');
      const r = await db.withTenant(a.tenantId, (tx) => repo.getConfig(tx, a, itemId));
      assertAccess(r.acc);
      if (!r.row) throw new AssignmentNotFoundError();
      return r.row;
    },

    async updateSettings(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      patch: Partial<AssignmentSettings>,
    ) {
      const a = spec(ctx, offeringId, 'assignment.manage');
      if (Object.keys(patch).length === 0)
        throw new InvalidAssignmentSettingsError('Nothing to change');
      const p = { ...patch } as SettingsPatch;
      if (p.opensAt && p.dueAt && new Date(p.dueAt) <= new Date(p.opensAt))
        throw new InvalidAssignmentSettingsError('The assignment must be due after it opens');
      if (p.dueAt && p.lateCutoffAt && new Date(p.lateCutoffAt) <= new Date(p.dueAt))
        throw new InvalidAssignmentSettingsError('The hard cutoff must come after the due date');
      try {
        const r = await db.withTenant(a.tenantId, (tx) => repo.updateSettings(tx, a, itemId, p));
        assertAccess(r.acc);
        if (!r.settings) throw new AssignmentNotFoundError();
        return r.settings;
      } catch (err) {
        if (pgErrorCode(err) === '23514') {
          const c = pgConstraint(err);
          throw new InvalidAssignmentSettingsError(
            c === 'assignments_window_ck'
              ? 'The assignment must be due after it opens'
              : c === 'assignments_late_ck'
                ? 'Accepting late work needs a due date and a hard cutoff after it'
                : c === 'assignments_types_ck'
                  ? 'Accept at least one of: files, text, a link'
                  : 'These settings are not valid',
          );
        }
        throw err;
      }
    },

    async replaceAttachments(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      fileIds: string[],
    ) {
      const a = spec(ctx, offeringId, 'assignment.manage');
      if (new Set(fileIds).size !== fileIds.length)
        throw new InvalidAssignmentSettingsError('A file is listed twice');
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.replaceAttachments(tx, a, itemId, fileIds),
      );
      staff(r);
      if (!r.filesOk) throw new AssignmentFileNotFoundError();
      return { attachments: r.attachments };
    },

    async attachRubric(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      rubricId: string | null,
    ) {
      const a = spec(ctx, offeringId, 'assignment.manage');
      const r = await db.withTenant(a.tenantId, (tx) => repo.attachRubric(tx, a, itemId, rubricId));
      staff(r);
      if (rubricId !== null) {
        if (!r.rubricFound) throw new RubricNotUsableError();
        if (r.archived) throw new RubricArchivedError();
      }
      if (!r.done) {
        if (r.blocked) throw new GradingStartedError();
        throw new AssignmentNotFoundError();
      }
      return { status: 'ok' as const };
    },

    // ================================================================ extensions (sensitive)
    async extensions(ctx: RequestContext, offeringId: string, itemId: string) {
      const a = spec(ctx, offeringId, 'assignment.view_extensions');
      const r = await db.withTenant(a.tenantId, (tx) => repo.listExtensions(tx, a, itemId));
      staff(r);
      return { items: r.rows };
    },

    async setExtension(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      participantId: string,
      input: { extendedDueAt: string; reason?: string | undefined },
    ) {
      const a = spec(ctx, offeringId, 'assignment.manage');
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.setExtension(tx, a, itemId, participantId, {
          extendedDueAt: input.extendedDueAt,
          reason: input.reason?.trim() || null,
        }),
      );
      staff(r);
      if (!r.dateOk)
        throw new InvalidAssignmentSettingsError(
          'An extension needs a due date on the assignment and must be later than it',
        );
      if (!r.participantOk || !r.row) throw new LearnerNotFoundError();
      return r.row;
    },

    async removeExtension(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      participantId: string,
    ) {
      const a = spec(ctx, offeringId, 'assignment.manage');
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.removeExtension(tx, a, itemId, participantId),
      );
      staff(r);
      if (!r.removed) throw new LearnerNotFoundError();
      return { status: 'ok' as const };
    },

    // ================================================================ the learner
    async me(ctx: RequestContext, offeringId: string, itemId: string) {
      const tenantId = tenantOf(ctx);
      const r = await db.withoutTenant((conn) =>
        repo.me(conn, {
          tenantId,
          userId: ctx.userId,
          offeringId,
          itemId,
          grace: config.graceSeconds,
        }),
      );
      learnerVerdict(r);
      return r;
    },

    /** Step 1 of a hand-in file: the type is decided from the allowlist here, the rules of the assignment in the database. */
    async requestUpload(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      input: { name: string; size: number },
    ) {
      const tenantId = tenantOf(ctx);
      const name = cleanFileName(input.name);
      if (BLOCKED_EXTENSIONS.has(extensionOf(name)) || /\.(exe|js|bat|sh)\./i.test(name))
        throw new BlockedFileTypeError();
      const kind = kindForName(name);
      if (!name || !kind) throw new FileTypeNotAllowedError();
      if (input.size > config.maxFileBytes)
        throw new SubmissionFileTooLargeError(Math.floor(config.maxFileBytes / 1048576));
      const fileId = newId();
      const key = storageKey(tenantId, fileId);
      const r = await db.withoutTenant((conn) =>
        repo.uploadBegin(conn, {
          tenantId,
          userId: ctx.userId,
          offeringId,
          itemId,
          fileId,
          storageKey: key,
          name,
          contentType: kind.mime,
          size: input.size,
          grace: config.graceSeconds,
          arrival: arrivalOf(ctx),
        }),
      );
      learnerVerdict(r);
      const maxBytes = Math.min(config.maxFileBytes, Number(r.maxMb) * 1048576);
      const upload = await storageCall(() =>
        storage.createUploadTarget({ key, contentType: kind.mime, maxBytes }),
      );
      return { fileId, upload, maxBytes };
    },

    /** Step 2: the bytes are checked (size, type against content, SHA-256) like every file; the file becomes `ready`. */
    async confirmUpload(ctx: RequestContext, offeringId: string, itemId: string, fileId: string) {
      const tenantId = tenantOf(ctx);
      // the same gate as every learner call: 404 for a non-participant, 403 for a participant who is not a learner
      const verdict = await db.withoutTenant((conn) =>
        repo.uploadCheck(conn, { tenantId, userId: ctx.userId, offeringId, itemId, fileId }),
      );
      if (verdict !== 'ok') {
        if (verdict !== 'not_found') learnerVerdict({ result: verdict });
        throw new AssignmentFileNotFoundError();
      }
      const file = await filesService.confirm(ctx, fileId);
      return {
        fileId: file.id as string,
        name: file.original_name as string,
        size: file.size == null ? null : Number(file.size),
        contentType: file.content_type as string,
      };
    },

    async submit(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      body: SubmitAssignmentRequest,
    ) {
      const tenantId = tenantOf(ctx);
      const r = await db.withoutTenant((conn) =>
        repo.submit(conn, {
          tenantId,
          userId: ctx.userId,
          offeringId,
          itemId,
          requestKey: body.requestKey,
          text: body.text ?? null,
          link: body.link ?? null,
          fileIds: body.fileIds,
          confirmLate: body.confirmLate === true,
          grace: config.graceSeconds,
          arrival: arrivalOf(ctx),
        }),
      );
      learnerVerdict(r);
      if (r.result === 'confirm_late') {
        return {
          result: 'confirm_late' as const,
          lateSeconds: Number(r.lateSeconds),
          penaltyPercent: Number(r.penaltyPercent),
          penaltyPoints: Number(r.penaltyPoints),
          maxPoints: Number(r.maxPoints),
          currentVersionNo: Number(r.currentVersionNo),
        };
      }
      return {
        result: 'ok' as const,
        submissionId: r.submissionId as string,
        versionNo: Number(r.versionNo),
        lateSeconds: Number(r.lateSeconds),
        onGrace: r.onGrace === true,
        penaltyPercent: Number(r.penaltyPercent ?? 0),
      };
    },

    /** A file the learner may download: an attachment, their own version or draft, a visible feedback file. */
    async learnerFile(ctx: RequestContext, offeringId: string, itemId: string, fileId: string) {
      const tenantId = tenantOf(ctx);
      const f = await db.withoutTenant((conn) =>
        repo.fileAccess(conn, { tenantId, userId: ctx.userId, offeringId, itemId, fileId }),
      );
      if (f.result !== 'ok') {
        if (f.result !== 'not_found') learnerVerdict(f);
        throw new AssignmentFileNotFoundError();
      }
      return filesService.downloadTarget({
        storage_key: f.storage_key as string,
        original_name: f.original_name as string,
        content_type: f.content_type as string,
      });
    },

    // ================================================================ grading
    async queue(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      q: {
        status?: string | undefined;
        sectionId?: string | undefined;
        sort?: QueueSort | undefined;
        limit?: number | undefined;
        after?: string | undefined;
      },
    ) {
      const a = spec(ctx, offeringId, 'submission.grade');
      const limit = Math.min(
        Math.max(Math.trunc(q.limit ?? DEFAULT_PAGE_LIMIT), 1),
        MAX_PAGE_LIMIT,
      );
      const after = q.after ? decodeCursor(q.after) : null;
      const sort: QueueSort = q.sort ?? 'default';
      const query = {
        status: q.status ?? null,
        section: q.sectionId ?? null,
        sort,
        limit,
        after,
      };
      const r = await withKeys(a, itemId, (tx) => repo.queue(tx, a, itemId, query));
      staff(r);
      // refused after the statement ran, but nothing leaves: the error carries no data
      if (r.blind && sort === 'name') throw new NameSortRefusedError();
      const hasMore = r.rows.length > limit;
      const page = hasMore ? r.rows.slice(0, limit) : r.rows;
      const last = page[page.length - 1];
      return {
        items: page.map(({ sk: _sk, ...row }) => row),
        nextCursor:
          hasMore && last
            ? encodeCursor({ sk: last.sk as string, key: last.learnerKey as string })
            : null,
        blind: r.blind,
        maxPoints: r.maxPoints ?? 0,
      };
    },

    async summary(ctx: RequestContext, offeringId: string, itemId: string) {
      const a = spec(ctx, offeringId, 'submission.grade');
      const r = await db.withTenant(a.tenantId, (tx) => repo.summary(tx, a, itemId));
      staff(r);
      return r.row as Row;
    },

    async learner(ctx: RequestContext, offeringId: string, itemId: string, learnerKey: string) {
      const a = spec(ctx, offeringId, 'submission.grade');
      const r = await db.withTenant(a.tenantId, (tx) => repo.learner(tx, a, itemId, learnerKey));
      staff(r);
      if (!r.row) throw new LearnerNotFoundError();
      return r.row;
    },

    async grade(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      learnerKey: string,
      input: GradeInput,
    ) {
      const a = spec(ctx, offeringId, 'submission.grade');
      const w: GradeWrite = {
        learnerKey,
        submissionId: input.submissionId,
        selection: input.rubricSelection ?? null,
        rawScore: input.rawScore ?? null,
        overrideReason: input.overrideReason ?? null,
        feedback: input.feedback,
        feedbackGiven: input.feedback !== undefined,
        feedbackFileIds: input.feedbackFileIds ?? null,
        userId: ctx.userId,
      };
      const r = await db.withTenant(a.tenantId, (tx) => repo.grade(tx, a, itemId, w));
      staff(r);
      if (!r.learnerOk) throw new LearnerNotFoundError();
      if (!r.submissionOk) throw new SubmissionChangedError();
      if (!r.rubricOk)
        throw new InvalidGradeError('Choose one level for every criterion of the rubric');
      if (!r.scoreGiven) throw new InvalidGradeError('Give a score');
      if (!r.scoreOk)
        throw new InvalidGradeError('The score must be between 0 and the maximum points');
      if (!r.overrideOk)
        throw new InvalidGradeError('A score that differs from the rubric needs a reason');
      if (!r.filesOk) throw new AssignmentFileNotFoundError();
      return r.row as Row;
    },

    async setWaiver(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      learnerKey: string,
      waive: { reason: string } | null,
    ) {
      const a = spec(ctx, offeringId, 'grade.finalize');
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.setWaiver(tx, a, itemId, learnerKey, waive ? { reason: waive.reason.trim() } : null),
      );
      staff(r);
      if (!r.changed) throw new NotGradedError();
      return { status: 'ok' as const };
    },

    async release(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      keys: string[] | undefined,
    ) {
      const a = spec(ctx, offeringId, 'grade.finalize');
      const r = await db.withTenant(a.tenantId, (tx) =>
        repo.release(tx, a, itemId, keys && keys.length > 0 ? keys : null),
      );
      staff(r);
      return { released: r.released };
    },

    /** A file of the assignment for a grader. While blind, a learner's own file name (it may hold their name) is replaced. */
    async staffFile(ctx: RequestContext, offeringId: string, itemId: string, fileId: string) {
      const a = spec(ctx, offeringId, 'submission.grade');
      const r = await db.withTenant(a.tenantId, (tx) => repo.staffFile(tx, a, itemId, fileId));
      staff(r);
      if (!r.file) throw new AssignmentFileNotFoundError();
      const f = r.file;
      const ext = extensionOf(f.name as string);
      const name =
        f.neutralName === true
          ? safeFileName(`${f.anonCode as string}-v${f.versionNo as number}${ext ? `.${ext}` : ''}`)
          : (f.name as string);
      return filesService.downloadTarget({
        storage_key: f.storageKey as string,
        original_name: name,
        content_type: f.contentType as string,
      });
    },

    /**
     * Every learner's LATEST submission as one ZIP: a folder per learner (register number; the anonymous code while blind),
     * the files, the text and link as small files, and `index.csv` (formula-safe). Streamed from storage one object at a time:
     * memory does not grow with the number of submissions. While blind nothing is named, ordered or grouped by identity.
     */
    async zip(ctx: RequestContext, offeringId: string, itemId: string) {
      const a = spec(ctx, offeringId, 'submission.grade');
      const m = await withKeys(a, itemId, (tx) => repo.zipManifest(tx, a, itemId));
      staff(m);
      const blind = m.blind;
      const rows = [...m.rows];
      if (blind) rows.sort((x, y) => String(x.anonCode).localeCompare(String(y.anonCode), 'en'));
      else
        rows.sort(
          (x, y) =>
            String(x.registerNumber ?? '￿').localeCompare(String(y.registerNumber ?? '￿'), 'en') ||
            String(x.name ?? '').localeCompare(String(y.name ?? ''), 'en') ||
            String(x.anonCode).localeCompare(String(y.anonCode), 'en'),
        );
      const folders = new Set<string>();
      const entries: ZipEntry[] = [];
      const csv: string[] = [
        csvLine(
          blind
            ? [
                'folder',
                'version',
                'submitted_at',
                'late',
                'late_seconds',
                'penalty_percent',
                'status',
                'files',
              ]
            : [
                'folder',
                'name',
                'email',
                'register_number',
                'version',
                'submitted_at',
                'late',
                'late_seconds',
                'penalty_percent',
                'status',
                'files',
              ],
        ),
      ];
      const bytesOf =
        (text: string): ZipEntry['open'] =>
        async () => {
          const { Readable } = await import('node:stream');
          return Readable.from([Buffer.from(text, 'utf8')]);
        };
      for (const r of rows) {
        const base = blind ? String(r.anonCode) : String(r.registerNumber ?? r.anonCode);
        const folder = uniqueName(folders, safeFileName(base, String(r.anonCode)));
        const used = new Set<string>();
        const when = r.submittedAt ? new Date(r.submittedAt as string) : new Date();
        const files = (r.files as { fileId: string; name: string; size: number | null }[]) ?? [];
        files.forEach((f, i) => {
          const ext = extensionOf(f.name);
          // while blind the file's own name may hold the learner's name: use a neutral one
          const wanted = blind ? `file-${i + 1}${ext ? `.${ext}` : ''}` : safeFileName(f.name);
          entries.push({
            name: `${folder}/${uniqueName(used, wanted)}`,
            size: Number(f.size ?? 0),
            modified: when,
            open: async () =>
              (await storageCall(() => storage.read(storageKey(a.tenantId, f.fileId))))?.stream ??
              null,
          });
        });
        if (r.text) {
          const t = String(r.text);
          entries.push({
            name: `${folder}/${uniqueName(used, 'submission.txt')}`,
            size: Buffer.byteLength(t),
            modified: when,
            open: bytesOf(t),
          });
        }
        if (r.link) {
          const t = `${String(r.link)}\r\n`;
          entries.push({
            name: `${folder}/${uniqueName(used, 'link.txt')}`,
            size: Buffer.byteLength(t),
            modified: when,
            open: bytesOf(t),
          });
        }
        const common = [
          r.versionNo as number,
          iso(r.submittedAt),
          Number(r.lateSeconds) > 0 ? 'yes' : 'no',
          Number(r.lateSeconds),
          Number(r.penaltyPercent),
          r.status as string,
          files.length,
        ];
        csv.push(
          csvLine(
            blind
              ? [folder, ...common]
              : [
                  folder,
                  r.name as string,
                  r.email as string,
                  r.registerNumber as string,
                  ...common,
                ],
          ),
        );
      }
      const index = csv.join('');
      entries.unshift({
        name: 'index.csv',
        size: Buffer.byteLength(index),
        open: bytesOf(index),
      });
      return { stream: zipStream(entries), fileName: 'submissions.zip', count: rows.length };
    },

    // ================================================================ the gradebook interface (step 11)
    /** One row per graded learner and assignment: the score that counts after the late penalty. The caller has checked access. */
    async finalScores(tenantId: string, offeringId: string): Promise<AssignmentFinalScore[]> {
      const rows = await db.withTenant(tenantId, (tx) =>
        repo.finalScores(tx, tenantId, offeringId),
      );
      return rows.map((r) => ({
        itemId: r.item_id as string,
        participantId: r.participant_id as string,
        rawScore: Number(r.raw_score),
        penaltyPercent: Number(r.penalty_percent),
        score: Number(r.score),
        maxScore: Number(r.max_score),
        percent: Number(r.percent),
        released: r.released === true,
        passingScore: r.passing_score == null ? null : Number(r.passing_score),
        late: r.late === true,
      }));
    },
  };
}
export type AssignmentsService = ReturnType<typeof createAssignmentsService>;
