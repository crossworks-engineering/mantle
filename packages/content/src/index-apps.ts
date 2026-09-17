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
export { acceptSceneSvg, SCENE_SVG_MAX_BYTES, EXCALIDRAW_ENGINE } from './scene-svg';
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
  saveDraftSource,
  writeDraftFile,
  deleteDraftFile,
  setManifest,
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
  listAppAccess,
  type AppAccessKind,
  type AppAccessEntry,
  type AppAccessRow,
} from './app-access-log';
