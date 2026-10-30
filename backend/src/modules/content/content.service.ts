import { can, type Permission, participationsGranting } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { ForbiddenError } from '../../core/errors';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import {
  type AccessRow,
  type AccessSpec,
  assertAccess,
  OfferingArchivedError,
  OfferingNotFoundError,
} from '../courses';
import type { FilesService } from '../files';
import { VideoNotReadyError, type VideoService } from '../video';
import {
  CopyInProgressError,
  CopyNotPossibleError,
  InvalidFileError,
  InvalidItemError,
  InvalidLinkError,
  InvalidRichTextError,
  InvalidVideoError,
  ItemNotFoundError,
  isPositionConflict,
  ModuleNotFoundError,
  mapContentDbError,
  NothingToChangeError,
  SiblingNotFoundError,
} from './content.errors';
import type { After, ContentRepository, Row } from './content.repository';
import { normalizeRichText } from './content.richtext';

export type { Row } from './content.repository';

/** A source with at most this many items is copied while the request waits; a larger one runs as a job. */
export const COPY_INLINE_LIMIT = 500;

export interface ItemInput {
  kind: 'text' | 'file' | 'link' | 'video';
  title: string;
  body?: unknown;
  fileId?: string | undefined;
  videoId?: string | undefined;
  url?: string | undefined;
  published?: boolean | undefined;
  availableFrom?: string | null | undefined;
  after?: string | null | undefined;
}

export interface ItemChange {
  title?: string | undefined;
  body?: unknown;
  fileId?: string | undefined;
  videoId?: string | undefined;
  url?: string | undefined;
  published?: boolean | undefined;
  availableFrom?: string | null | undefined;
}

/** An http(s) address, normalised; anything else (javascript:, data:, mailto: ...) is refused. */
function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new InvalidLinkError();
    return u.href;
  } catch {
    throw new InvalidLinkError();
  }
}

function cleanBody(raw: unknown): unknown {
  const r = normalizeRichText(raw);
  if (!r.ok) throw new InvalidRichTextError(r.problems);
  return r.doc;
}

export function createContentService(deps: {
  db: Pick<Database, 'withTenant'>;
  contentRepo: ContentRepository;
  filesService: FilesService;
  videoService: VideoService;
}) {
  const { db, contentRepo, filesService, videoService } = deps;

  function spec(ctx: RequestContext, offeringId: string, permission: Permission): AccessSpec {
    if (!ctx.tenantId) throw new ForbiddenError();
    return {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      offeringId,
      viewAll: can(ctx, 'course.read'),
      accountAllowed: can(ctx, permission),
      allowedBy: participationsGranting(permission),
    };
  }

  /** Two requests may pick the same position at once: the loser retries and picks again. */
  async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (isPositionConflict(err) && attempt < 4) continue;
        throw mapContentDbError(err) ?? err;
      }
    }
  }

  /** Access and archive checks shared by every edit; returns the row for further checks. */
  function mayEdit(acc: AccessRow | null): AccessRow {
    const a = assertAccess(acc);
    if (a.status === 'archived') throw new OfferingArchivedError();
    return a;
  }

  return {
    async outline(ctx: RequestContext, offeringId: string) {
      const a = spec(ctx, offeringId, 'content.view');
      const r = await db.withTenant(a.tenantId, (tx) => contentRepo.outline(tx, a));
      const acc = assertAccess(r.acc);
      const canEdit =
        can(ctx, 'course.edit') ||
        (acc.participation !== null &&
          participationsGranting('course.edit').includes(acc.participation));
      return { offeringId, canEdit, modules: r.modules };
    },

    async getItem(ctx: RequestContext, offeringId: string, itemId: string): Promise<Row> {
      const a = spec(ctx, offeringId, 'content.view');
      const r = await db.withTenant(a.tenantId, (tx) => contentRepo.getItem(tx, a, itemId));
      assertAccess(r.acc);
      if (!r.item) throw new ItemNotFoundError();
      return r.item;
    },

    /** A signed, expiring download URL for the file of an item the caller may open. */
    async downloadFile(ctx: RequestContext, offeringId: string, itemId: string) {
      const a = spec(ctx, offeringId, 'content.view');
      const r = await db.withTenant(a.tenantId, (tx) => contentRepo.itemFile(tx, a, itemId));
      assertAccess(r.acc);
      if (!r.file || r.locked) throw new ItemNotFoundError();
      return filesService.downloadTarget({
        storage_key: r.file.storage_key as string,
        original_name: r.file.original_name as string,
        content_type: r.file.content_type as string,
      });
    },

    /**
     * A playback session for the video of an item the caller may open (not locked, not hidden, caller takes part
     * in the offering): the same visibility rules as the outline, decided in one statement. 4 round trips.
     */
    async playback(ctx: RequestContext, offeringId: string, itemId: string) {
      const a = spec(ctx, offeringId, 'content.view');
      const r = await db.withTenant(a.tenantId, (tx) => contentRepo.itemVideo(tx, a, itemId));
      assertAccess(r.acc);
      if (!r.video || r.locked) throw new ItemNotFoundError();
      if (r.video.status !== 'ready') throw new VideoNotReadyError();
      return videoService.createPlayback(ctx, {
        assetId: r.video.assetId as string,
        durationMs: Number(r.video.durationMs),
        renditions: (r.video.renditions as { name: string; height: number }[]) ?? [],
        captions: (r.video.captions as { language: string; label: string }[]) ?? [],
      });
    },

    // ---------------------------------------------------------------- modules
    async createModule(
      ctx: RequestContext,
      offeringId: string,
      input: { title: string; after?: string | null | undefined },
    ): Promise<Row> {
      const a = spec(ctx, offeringId, 'course.edit');
      const after: After = input.after;
      const r = await withRetry(() =>
        db.withTenant(a.tenantId, (tx) =>
          contentRepo.createModule(tx, a, { id: newId(), title: input.title.trim(), after }),
        ),
      );
      mayEdit(r.acc);
      if (!r.posFound) throw new SiblingNotFoundError();
      return r.row as Row;
    },

    async updateModule(
      ctx: RequestContext,
      offeringId: string,
      moduleId: string,
      change: {
        title?: string | undefined;
        published?: boolean | undefined;
        availableFrom?: string | null | undefined;
      },
    ): Promise<Row> {
      const a = spec(ctx, offeringId, 'course.edit');
      const v: { title?: string; published?: boolean; availableFrom?: string | null } = {};
      if (change.title !== undefined) v.title = change.title.trim();
      if (change.published !== undefined) v.published = change.published;
      if (change.availableFrom !== undefined) v.availableFrom = change.availableFrom;
      if (Object.keys(v).length === 0) throw new NothingToChangeError();
      const r = await db.withTenant(a.tenantId, (tx) =>
        contentRepo.updateModule(tx, a, moduleId, v),
      );
      mayEdit(r.acc);
      if (!r.row) throw new ModuleNotFoundError();
      return r.row;
    },

    async moveModule(
      ctx: RequestContext,
      offeringId: string,
      moduleId: string,
      after: string | null,
    ): Promise<Row> {
      const a = spec(ctx, offeringId, 'course.edit');
      const r = await withRetry(() =>
        db.withTenant(a.tenantId, (tx) => contentRepo.moveModule(tx, a, moduleId, after)),
      );
      mayEdit(r.acc);
      if (!r.row)
        throw r.posFound || after === null ? new ModuleNotFoundError() : new SiblingNotFoundError();
      return r.row;
    },

    async deleteModule(ctx: RequestContext, offeringId: string, moduleId: string): Promise<void> {
      const a = spec(ctx, offeringId, 'course.edit');
      const r = await db.withTenant(a.tenantId, (tx) => contentRepo.deleteModule(tx, a, moduleId));
      mayEdit(r.acc);
      if (!r.deleted) throw new ModuleNotFoundError();
    },

    // ---------------------------------------------------------------- items
    async createItem(
      ctx: RequestContext,
      offeringId: string,
      moduleId: string,
      input: ItemInput,
    ): Promise<Row> {
      const a = spec(ctx, offeringId, 'course.edit');
      const v = {
        id: newId(),
        kind: input.kind,
        title: input.title.trim(),
        body: null as unknown,
        fileId: null as string | null,
        videoId: null as string | null,
        url: null as string | null,
        published: input.published ?? false,
        availableFrom: input.availableFrom ?? null,
        after: input.after as After,
      };
      if (input.kind === 'text') {
        if (input.body === undefined || input.fileId || input.url || input.videoId) {
          throw new InvalidItemError();
        }
        v.body = cleanBody(input.body);
      } else if (input.kind === 'file') {
        if (!input.fileId || input.body !== undefined || input.url || input.videoId) {
          throw new InvalidItemError();
        }
        v.fileId = input.fileId;
      } else if (input.kind === 'video') {
        if (!input.videoId || input.body !== undefined || input.fileId || input.url) {
          throw new InvalidItemError();
        }
        v.videoId = input.videoId;
      } else {
        if (!input.url || input.body !== undefined || input.fileId || input.videoId) {
          throw new InvalidItemError();
        }
        v.url = cleanUrl(input.url);
      }
      const r = await withRetry(() =>
        db.withTenant(a.tenantId, (tx) => contentRepo.createItem(tx, a, moduleId, v, ctx.userId)),
      );
      mayEdit(r.acc);
      if (!r.moduleFound) throw new ModuleNotFoundError();
      if (!r.posFound) throw new SiblingNotFoundError();
      if (!r.fileOk) throw new InvalidFileError();
      if (!r.videoOk) throw new InvalidVideoError();
      return r.item as Row;
    },

    async updateItem(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      change: ItemChange,
    ): Promise<Row> {
      const a = spec(ctx, offeringId, 'course.edit');
      const v: Parameters<ContentRepository['updateItem']>[3] = {};
      if (change.title !== undefined) v.title = change.title.trim();
      if (change.body !== undefined) v.body = cleanBody(change.body);
      if (change.url !== undefined) v.url = cleanUrl(change.url);
      if (change.fileId !== undefined) v.fileId = change.fileId;
      if (change.videoId !== undefined) v.videoId = change.videoId;
      if (change.published !== undefined) v.published = change.published;
      if (change.availableFrom !== undefined) v.availableFrom = change.availableFrom;
      if (Object.keys(v).length === 0) throw new NothingToChangeError();
      const r = await withRetry(() =>
        db.withTenant(a.tenantId, (tx) => contentRepo.updateItem(tx, a, itemId, v, ctx.userId)),
      );
      mayEdit(r.acc);
      if (!r.fileOk) throw new InvalidFileError();
      if (!r.videoOk) throw new InvalidVideoError();
      if (!r.item) throw new ItemNotFoundError();
      return r.item;
    },

    async moveItem(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      to: { moduleId?: string | undefined; after: string | null },
    ): Promise<Row> {
      const a = spec(ctx, offeringId, 'course.edit');
      const r = await withRetry(() =>
        db.withTenant(a.tenantId, (tx) => contentRepo.moveItem(tx, a, itemId, to)),
      );
      mayEdit(r.acc);
      if (!r.item)
        throw r.posFound || to.after === null
          ? new ItemNotFoundError()
          : new SiblingNotFoundError();
      return r.item;
    },

    async deleteItem(ctx: RequestContext, offeringId: string, itemId: string): Promise<void> {
      const a = spec(ctx, offeringId, 'course.edit');
      const r = await db.withTenant(a.tenantId, (tx) => contentRepo.deleteItem(tx, a, itemId));
      mayEdit(r.acc);
      if (!r.deleted) throw new ItemNotFoundError();
    },

    // ---------------------------------------------------------------- copy
    /**
     * Copies the content of another offering to the end of this one (as unpublished drafts; the copies share
     * the files). Needs course.publish here and the right to edit the source (or to administer the college).
     */
    async copyFrom(ctx: RequestContext, targetId: string, sourceId: string) {
      if (targetId === sourceId)
        throw new CopyNotPossibleError('An offering cannot be copied into itself');
      const target = spec(ctx, targetId, 'course.publish');
      const source: AccessSpec = {
        ...spec(ctx, sourceId, 'course.edit'),
        accountAllowed: false,
        viewAll: can(ctx, 'course.read'),
      };
      const r = await db.withTenant(target.tenantId, (tx) =>
        contentRepo.copy(
          tx,
          { tenantId: target.tenantId, sourceId, targetId, actorUserId: ctx.userId },
          { target, source, inlineLimit: COPY_INLINE_LIMIT },
        ),
      );
      mayEdit(r.targetAcc);
      if (!r.sourceAcc?.visible) throw new OfferingNotFoundError();
      if (!r.sourceAcc.allowed) throw new ForbiddenError();
      if (r.busy) throw new CopyInProgressError();
      return { status: r.mode ?? 'done', modules: r.modules, items: r.items };
    },

    /** The `content.copy` job: copies a large source in the background (a retry after success does nothing). */
    async runCopy(
      tenantId: string,
      job: { sourceId: string; targetId: string; actorUserId: string },
      attempt: { number: number; max: number },
    ): Promise<{ modules: number; items: number }> {
      try {
        const r = await db.withTenant(tenantId, (tx) => contentRepo.copy(tx, { tenantId, ...job }));
        return { modules: r.modules, items: r.items };
      } catch (err) {
        if (attempt.number >= attempt.max) {
          await db.withTenant(tenantId, (tx) =>
            contentRepo.setCopyStatus(tx, tenantId, job.targetId, 'failed'),
          );
        }
        throw err;
      }
    },
  };
}
export type ContentService = ReturnType<typeof createContentService>;
