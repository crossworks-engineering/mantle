import * as schema from './schema/index';

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
export { rawWriteTarget, writeRoleSettingsSql } from './gateway/write-route';
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
  createHomeFallback,
  loginScopeColumns,
  loginScopeFor,
  seedLoginScope,
  viewerScopeFor,
  withViewer,
} from './gateway/viewer-scope';

export { schema };
