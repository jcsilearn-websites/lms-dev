import {
  COMMON_ERRORS,
  CopyContentRequestSchema,
  CopyContentResponseSchema,
  CreateItemRequestSchema,
  CreateModuleRequestSchema,
  DownloadTargetSchema,
  ItemSchema,
  ModuleSchema,
  MoveItemRequestSchema,
  MoveRequestSchema,
  OfferingItemParamsSchema,
  OfferingModuleParamsSchema,
  OfferingParamsSchema,
  OkResponseSchema,
  OutlineSchema,
  PlaybackSessionSchema,
  UpdateItemRequestSchema,
  UpdateModuleRequestSchema,
} from '../../contracts';

const tags = ['content'];

export const outlineRouteSchema = {
  tags,
  summary:
    'The outline of an offering (modules and items, no bodies). A learner gets published entries only; locked ones show title and availableFrom',
  params: OfferingParamsSchema,
  response: { 200: OutlineSchema, ...COMMON_ERRORS },
};
export const getItemRouteSchema = {
  tags,
  summary: 'One item with its text (locked: no body, no file, no link)',
  params: OfferingItemParamsSchema,
  response: { 200: ItemSchema, ...COMMON_ERRORS },
};
export const downloadItemRouteSchema = {
  tags,
  summary: 'A short-lived signed download URL for the file of an item',
  params: OfferingItemParamsSchema,
  response: { 200: DownloadTargetSchema, ...COMMON_ERRORS },
};

export const playbackRouteSchema = {
  tags,
  summary:
    'A short-lived playback session (manifest URL, poster, captions) for the video of an item the caller may open',
  params: OfferingItemParamsSchema,
  response: { 200: PlaybackSessionSchema, ...COMMON_ERRORS },
};

export const createModuleRouteSchema = {
  tags,
  summary: 'Add a module (at the end unless `after` says where)',
  params: OfferingParamsSchema,
  body: CreateModuleRequestSchema,
  response: { 201: ModuleSchema, ...COMMON_ERRORS },
};
export const updateModuleRouteSchema = {
  tags,
  summary: 'Rename, publish or schedule a module',
  params: OfferingModuleParamsSchema,
  body: UpdateModuleRequestSchema,
  response: { 200: ModuleSchema, ...COMMON_ERRORS },
};
export const moveModuleRouteSchema = {
  tags,
  summary: 'Move a module after a sibling (null = first); rewrites one row',
  params: OfferingModuleParamsSchema,
  body: MoveRequestSchema,
  response: { 200: ModuleSchema, ...COMMON_ERRORS },
};
export const deleteModuleRouteSchema = {
  tags,
  summary: 'Delete a module and its items',
  params: OfferingModuleParamsSchema,
  response: { 200: OkResponseSchema, ...COMMON_ERRORS },
};

export const createItemRouteSchema = {
  tags,
  summary: 'Add an item (text, file, link or a READY video) to a module',
  params: OfferingModuleParamsSchema,
  body: CreateItemRequestSchema,
  response: { 201: ItemSchema, ...COMMON_ERRORS },
};
export const updateItemRouteSchema = {
  tags,
  summary: 'Change an item (title, text, file, link, publish, availableFrom)',
  params: OfferingItemParamsSchema,
  body: UpdateItemRequestSchema,
  response: { 200: ItemSchema, ...COMMON_ERRORS },
};
export const moveItemRouteSchema = {
  tags,
  summary: 'Move an item after a sibling, in its module or into another one; rewrites one row',
  params: OfferingItemParamsSchema,
  body: MoveItemRequestSchema,
  response: { 200: ItemSchema, ...COMMON_ERRORS },
};
export const deleteItemRouteSchema = {
  tags,
  summary: 'Delete an item',
  params: OfferingItemParamsSchema,
  response: { 200: OkResponseSchema, ...COMMON_ERRORS },
};

export const copyRouteSchema = {
  tags,
  summary:
    'Copy the content of another offering to the end of this one (as unpublished drafts, sharing the files); large sources run as a job',
  params: OfferingParamsSchema,
  body: CopyContentRequestSchema,
  response: { 200: CopyContentResponseSchema, 202: CopyContentResponseSchema, ...COMMON_ERRORS },
};
