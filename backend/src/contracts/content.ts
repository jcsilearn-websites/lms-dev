import { type Static, Type } from '@sinclair/typebox';
import { ItemVideoSchema } from './video';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const Nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([Type.Null(), t]);

export const CONTENT_KINDS = ['text', 'file', 'link', 'video'] as const;
export const ContentKindSchema = Type.Union([
  Type.Literal('text'),
  Type.Literal('file'),
  Type.Literal('link'),
  Type.Literal('video'),
]);
export type ContentKind = Static<typeof ContentKindSchema>;

/**
 * Rich text is a document TREE (ProseMirror / Tiptap JSON), never HTML. The server accepts only the nodes and
 * marks below (see content.richtext.ts) and the browser renders it with its own React renderer. The schema
 * here is deliberately loose (the allowlist lives in the validator, which also normalises the document).
 */
export const RichTextSchema = Type.Object(
  { type: Type.Literal('doc'), content: Type.Optional(Type.Array(Type.Any())) },
  { additionalProperties: false },
);
export type RichText = Static<typeof RichTextSchema>;

// ------------------------------------------------------------------ the outline
export const OutlineFileSchema = Type.Object({
  id: Id,
  name: Type.String(),
  size: Type.Integer(),
  contentType: Type.String(),
});

export const OutlineItemSchema = Type.Object({
  id: Id,
  moduleId: Id,
  kind: ContentKindSchema,
  title: Type.String(),
  /** Always true for a learner (an unpublished item is not sent to them at all). */
  published: Type.Boolean(),
  /** When it opens (the later of the item's and its module's date); null = open. */
  availableFrom: Nullable(DateTime),
  /** The learner cannot open it yet: only the title and `availableFrom` are sent. */
  locked: Type.Boolean(),
  url: Nullable(Type.String()),
  file: Type.Union([Type.Null(), OutlineFileSchema]),
  /** A video item's video (null for other kinds and for a locked item). */
  video: Type.Union([Type.Null(), ItemVideoSchema]),
  /** A text item has a body (fetched with GET .../items/:id; the outline stays small). */
  hasBody: Type.Boolean(),
});
export type OutlineItem = Static<typeof OutlineItemSchema>;

export const OutlineModuleSchema = Type.Object({
  id: Id,
  title: Type.String(),
  published: Type.Boolean(),
  availableFrom: Nullable(DateTime),
  items: Type.Array(OutlineItemSchema),
});
export type OutlineModule = Static<typeof OutlineModuleSchema>;

export const OutlineSchema = Type.Object({
  offeringId: Id,
  /** What the caller can do with the content: editors see unpublished and locked entries in full. */
  canEdit: Type.Boolean(),
  modules: Type.Array(OutlineModuleSchema),
});
export type OutlineDto = Static<typeof OutlineSchema>;

export const ItemSchema = Type.Object({
  id: Id,
  moduleId: Id,
  kind: ContentKindSchema,
  title: Type.String(),
  published: Type.Boolean(),
  availableFrom: Nullable(DateTime),
  locked: Type.Boolean(),
  url: Nullable(Type.String()),
  file: Type.Union([Type.Null(), OutlineFileSchema]),
  video: Type.Union([Type.Null(), ItemVideoSchema]),
  body: Type.Union([Type.Null(), RichTextSchema]),
  updatedAt: DateTime,
});
export type ItemDto = Static<typeof ItemSchema>;

export const ModuleSchema = Type.Object({
  id: Id,
  title: Type.String(),
  published: Type.Boolean(),
  availableFrom: Nullable(DateTime),
});

// ------------------------------------------------------------------ requests
export const OfferingModuleParamsSchema = Type.Object({ id: Id, moduleId: Id });
export const OfferingItemParamsSchema = Type.Object({ id: Id, itemId: Id });

/**
 * Where something goes among its siblings: omitted = at the end, `null` = first, an id = right after that
 * sibling. One value, so a drag-and-drop and a keyboard "move up / down" send the same request.
 */
const After = Type.Optional(Type.Union([Type.Null(), Id]));

export const CreateModuleRequestSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  after: After,
});
export const UpdateModuleRequestSchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  published: Type.Optional(Type.Boolean()),
  availableFrom: Type.Optional(Nullable(DateTime)),
});
export const MoveRequestSchema = Type.Object({ after: Type.Union([Type.Null(), Id]) });
export const MoveItemRequestSchema = Type.Object({
  /** the module to move to (default: stay in the same module) */
  moduleId: Type.Optional(Id),
  after: Type.Union([Type.Null(), Id]),
});

export const CreateItemRequestSchema = Type.Object({
  kind: ContentKindSchema,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.Optional(RichTextSchema),
  fileId: Type.Optional(Id),
  /** a video item: the READY video (uploaded in this offering by the caller, or already used here) */
  videoId: Type.Optional(Id),
  url: Type.Optional(Type.String({ maxLength: 2000 })),
  published: Type.Optional(Type.Boolean()),
  availableFrom: Type.Optional(Nullable(DateTime)),
  after: After,
});
export const UpdateItemRequestSchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  body: Type.Optional(RichTextSchema),
  fileId: Type.Optional(Id),
  /** replace the video of a video item */
  videoId: Type.Optional(Id),
  url: Type.Optional(Type.String({ maxLength: 2000 })),
  published: Type.Optional(Type.Boolean()),
  availableFrom: Type.Optional(Nullable(DateTime)),
});

export const CopyContentRequestSchema = Type.Object({ sourceOfferingId: Id });
export type ModuleDto = Static<typeof ModuleSchema>;

export const CopyContentResponseSchema = Type.Object({
  /** done: copied now; queued: a large copy runs in the background (the offering's copyStatus says when it ends) */
  status: Type.Union([Type.Literal('done'), Type.Literal('queued')]),
  modules: Type.Integer(),
  items: Type.Integer(),
});

export type CopyContentResponse = Static<typeof CopyContentResponseSchema>;
