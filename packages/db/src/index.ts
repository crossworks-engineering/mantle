export * from './schema/index';
export { db, closeDb, type Db } from './client';
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
