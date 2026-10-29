/**
 * @mantle/content · apps
 *
 * Apps and drawings — mini-apps, their access log, CLI sandboxes and the scene/draw surface.
 *
 * One of the package index's export lists, split by area so adding one
 * export touches one small file and two sessions adding a DTO do not
 * collide. Curation is deliberate here: the
 * alternative, `export *`, would publish every module's internals (tuning
 * constants like EMBED_TEXT_PER_FILE, helpers like renderIdentityBlock) as
 * API nobody chose to promise.
 */

export {
  DRAWS_ROOT_LABEL,
  EMPTY_SCENE,
  SCENE_MAX_ELEMENTS,
  SCENE_MAX_BYTES,
  sceneWithinLimits,
  normalizeScene,
  listDraws,
  countDraws,
  listDrawTags,
  getDraw,
  getDrawMeta,
  getDrawSvg,
  getDrawSnapshot,
  setDrawSvg,
  listStaleDrawSnapshots,
  getDrawSceneText,
  createDraw,
  updateDraw,
  saveDrawDraft,
  discardDrawDraft,
  commitDraw,
  deleteDraw,
  withDrawLock,
  type DrawRow,
  type DrawDetail,
  type DrawSort,
  type DrawVisibility,
  type CreateDrawInput,
  type UpdateDrawInput,
  type SaveDrawDraftResult,
  type CommitDrawResult,
  type LockedDrawRow,
} from './draws';
export { sceneToText } from './scene-to-text';
export {
  readableDraw,
  readableDrawText,
  readableDrawSvg,
  scopedDrawSvg,
  type ReadableDraw,
} from './draw-reader';
export {
  DRAW_PNG_LONG_EDGE,
  renderDrawSvgPng,
  cachedDrawPng,
  cacheDrawPng,
  validRegion,
  type DrawPng,
  type DrawRegion,
} from './draw-png';
export { acceptSceneSvg, keepSvgImages, SCENE_SVG_MAX_BYTES, EXCALIDRAW_ENGINE } from './scene-svg';
export {
  APPS_ROOT_LABEL,
  DEFAULT_ENTRY,
  emptySource,
  sourceToText,
  workingSource,
  listApps,
  countApps,
  listAppTags,
  getApp,
  createApp,
  assertNewAppCodeRight,
  updateAppMeta,
  setAppAuthorLevel,
  lowerAuthorLevel,
  saveDraftSource,
  AppDraftConflictError,
  getAppRuntime,
  type AppRuntime,
  type AppToolRules,
  type PublishAppOpts,
  type AppHistoryActor,
  AppRestoreDraftError,
  restoreAppDraft,
  restoreAppLive,
  writeDraftFile,
  deleteDraftFile,
  setManifest,
  declareAppSchema,
  setDraftBuild,
  discardDraft as discardAppDraft,
  publishApp,
  setAppAuthorSummary,
  appSummaryHash,
  deleteApp,
  CannotDeleteEntryError,
  NoGreenBuildError,
  AppSourceLimitError,
  assertSourceWithinLimits,
  MAX_APP_FILES,
  MAX_APP_FILE_BYTES,
  MAX_APP_PATH_LEN,
  type AppRow,
  type AppDetail,
  type AppSort,
  type CreateAppInput,
  type UpdateAppInput,
} from './apps';

export {
  listMemberApps,
  getMemberRunnableApp,
  listTeamLevelAppIds,
  memberMayWriteAppData,
  memberReachSql,
  memberWritesSql,
  resolveMemberHomeApp,
  firstSharedWorkspaceId,
  workspaceLandingAppId,
  type MemberAppCard,
  type MemberRunnableApp,
} from './member-apps';

export {
  appLauncher,
  buildAppLauncherFolders,
  type AppFolderRow,
  type AppLauncherReader,
  type AppPlace,
} from './app-folders';

export {
  MCP_DATA_APPS_MAX,
  getMcpDataApp,
  listMcpDataApps,
  type McpDataApp,
  type McpDataRole,
} from './mcp-app-data';

export { dataAccessOf, type AppDataAccess } from './app-data-access';

export {
  APP_NAV_CHANGED_CHANNEL,
  listAppNavItems,
  loadAppNavView,
  notifyAppNavChanged,
  recordAppOpen,
  saveAppPins,
} from './app-nav';

export {
  SANDBOX_NAME_RE,
  createSandboxRow,
  listSandboxes,
  getSandboxByRef,
  touchSandbox,
  setSandboxStatus,
  deleteSandboxRow,
} from './sandboxes';
export {
  recordAppAccess,
  recordAppError,
  listAppAccess,
  reapAppAccessLog,
  APP_ACCESS_LOG_RETENTION_DAYS,
  APP_ACCESS_QUERY_SAMPLE_MS,
  APP_ERROR_LOG_PER_MINUTE,
  type AppAccessKind,
  type AppErrorEntry,
  type AppAccessEntry,
  type AppAccessRow,
} from './app-access-log';
