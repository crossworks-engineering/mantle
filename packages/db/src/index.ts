export * from './schema/index';
export { db, systemDb, closeDb, type Db } from './client';
export {
  VIEWER_LEVELS,
  currentViewerLevel,
  isViewerLevel,
  lowerLevel,
  withViewer,
  viewerRoleName,
  type LimitedLevel,
  type ViewerLevel,
} from './viewer';
export { ensureViewerRoles, LIMITED_LEVELS } from './viewer-roles';
export {
  ACCESS_MATRIX,
  WORKSPACE_NODE_TYPES,
  applyViewerGrants,
  type TableAccess,
} from './access-matrix';
export { getDefaultWorker, getAgentTtsWorker, bumpWorkerUsage } from './ai-workers-resolve';
export { bumpAgentUsage } from './agents-resolve';
export {
  resolveContextRef,
  CONTEXT_KINDS,
  type ContextKind,
  type ContextRef,
  type ResolvedContextRef,
} from './context-ref-resolve';
export { notifyNodeIngested, notifyNodeIndexed } from './notify';
export { isWriteRefused } from './write-refused';
export {
  countUsers,
  resolveSingleOwnerId,
  isBrainOwnerId,
  waitForOwner,
  type WaitForOwnerOpts,
} from './resolve-owner';
export {
  noteRef,
  activeNotes,
  applyPersonaUpdate,
  capNotes,
  dedupeNewNotes,
  MAX_PERSONA_NOTES,
  type PersonaUpdate,
  type PersonaUpdateResult,
} from './persona-notes';
export {
  sql,
  eq,
  ne,
  and,
  or,
  not,
  isNull,
  isNotNull,
  inArray,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  desc,
  asc,
} from 'drizzle-orm';
