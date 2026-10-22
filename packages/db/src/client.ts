/**
 * A re-export barrel, nothing more: the database gateway lives in
 * packages/db/src/gateway/ (pools, check-mode, actor-sql, role-tx,
 * role-runner, write-route, system-tx, scope, scope-answers, heads,
 * viewer-scope, handles), split out of this file. It re-exports every
 * name this file exported before, so index.ts, `@mantle/db/client` and the
 * tests that mock this module are unchanged.
 *
 * It stays one release, then goes: add no code here, and import a gateway
 * module (inside packages/db) or `@mantle/db` (outside) instead.
 */
export {
  ACTOR_CHECK_DRIFT_SQL,
  EDIT_CHECK_DRIFT_SQL,
  refreshActorCheckMode,
} from './gateway/check-mode';
export {
  actorClient,
  actorInTransaction,
  needsActorWrap,
  RESET_ACTOR_SQL,
  runsOutsideTransaction,
  setActorSql,
} from './gateway/actor-sql';
export { closeDb, openLoginWritePool, systemPoolRole } from './gateway/pools';
export {
  afterOuterCommit,
  afterOuterRollback,
  inOpenTransaction,
  JoinedWriteEndedError,
  NESTED_SAVEPOINT_WARN,
  setWritePoolWaitForTests,
  watchedSendsForTests,
  WritePoolBusyError,
} from './gateway/role-tx';
export { writeRoleSettingsSql } from './gateway/write-route';
export {
  brokerLockTx,
  NestedSystemTxError,
  systemPoolTxInScope,
  withSystemTx,
  type SystemPoolScope,
} from './gateway/system-tx';
export {
  readTransaction,
  ScopeLostError,
  turnScopedClient,
  turnScopeProblem,
  withScope,
  withTurnScope,
} from './gateway/scope';
export {
  db,
  executeAsMigrator,
  executeWrite,
  isWriteSql,
  NotAWriteError,
  systemDb,
  type Db,
} from './gateway/handles';
export {
  folderHeadIds,
  headsOrSpace,
  lockMoreHeads,
  onSpaceRows,
  withDeadlockRetry,
  withHeads,
  withNodeDeleteHeads,
  withNodeInsertHeads,
  withNodeMoveHeads,
  withSpaceRows,
  withSubtreeHeads,
  withWriterHeads,
} from './gateway/heads';
export {
  loginActorNow,
  loginAreas,
  loginHasArea,
  loginHoldsAdmin,
  moderatorSeatsNow,
  scopeHasArea,
  scopeHoldsAdmin,
} from './gateway/scope-answers';
export {
  appHolderHomes,
  createHomeFallback,
  loginScopeColumns,
  loginScopeFor,
  seedLoginScope,
  viewerScopeFor,
  withViewer,
} from './gateway/viewer-scope';
export * as schema from './schema/index';
