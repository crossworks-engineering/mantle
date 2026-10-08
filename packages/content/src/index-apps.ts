/**
 * @mantle/content · apps
 *
 * Apps and drawings — mini-apps, their access log, CLI sandboxes and the scene/draw surface.
 *
 * Split out of the 962-line index.ts on 2026-09-02 (audit, tier 3). The
 * export lists are UNCHANGED — this package's public surface is exactly what
 * it was. What changed is that adding one export now touches one small file
 * instead of the single barrel that saw 102 commits in 90 days, so two
 * sessions adding a DTO no longer collide. Curation is deliberate here: the
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
  updateAppMeta,
  setAppAuthorLevel,
  lowerAuthorLevel,
  saveDraftSource,
  AppDraftConflictError,
  getAppRuntime,
  type AppRuntime,
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
  MEMBER_APP_LEVELS,
  MEMBER_LISTED_APP_LEVELS,
  isMemberAppLevel,
  listMemberApps,
  getMemberRunnableApp,
  listTeamLevelAppIds,
  listAppIdsUsedAt,
  memberMayWriteAppData,
  resolveMemberHomeApp,
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
  CLIENT_APP_LEVELS,
  isClientAppLevel,
  listClientApps,
  getClientRunnableApp,
  type ClientAppCard,
  type ClientRunnableApp,
} from './client-apps';

export {
  MCP_DATA_APPS_MAX,
  getMcpDataApp,
  listMcpDataApps,
  type McpDataApp,
  type McpDataRole,
} from './mcp-app-data';

export { dataAccessOf, type AppDataAccess } from './app-data-access';

export {
  SpaceAppError,
  acceptSpaceApp,
  adminSpaceApp,
  adminUnshareSpaceApp,
  listSpaceAppsForAdmin,
  type AdminSpaceAppRow,
  authorSpaceApp,
  createSpaceApp,
  getRunnableSpaceApp,
  getSpaceAppSubmission,
  listSpaceAppSubmissions,
  listSpaceApps,
  recallSpaceApp,
  returnSpaceApp,
  setSpaceAppSharing,
  spaceAppDataReadOnly,
  spaceAppReviewHash,
  submitSpaceApp,
  withAuthorWrite,
  type RunnableSpaceApp,
  type SpaceAppAcceptLevel,
  type SpaceAppAuthor,
  type SpaceAppCard,
  type SpaceAppErrorCode,
  type SpaceAppState,
  type SpaceAppSubmission,
} from './member-space-apps';

export {
  APP_NAV_CHANGED_CHANNEL,
  APP_NAV_LAYOUT_RETIRED,
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
