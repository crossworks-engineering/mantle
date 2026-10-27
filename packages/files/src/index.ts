export {
  folderSlugOf,
  slugifyFolder,
  sanitizeFilename,
  dashToLtree,
  ltreeToDash,
  extOf,
  mimeForExt,
  TEXT_EXTS,
  TIKA_EXTS,
  INGESTABLE_EXTS,
  MEDIA_EXTS,
  PREVIEWABLE_MARKDOWN_EXTS,
  EXPORT_REQUIRED_EXTS,
  exportHintForExt,
  parserRouteForExt,
  isVisionImage,
  type ParserRoute,
} from './slug';

export { isHeic, transcodeImageForVision } from './transcode';

export { parseDocumentBytes } from './parse';

export { extractPdfTextWithPassword, type PdfPasswordResult } from './pdf-password';

export { parseTikaBytes, tikaIsUp, tikaVersion } from './tika';

export {
  mediaSidecarEnabled,
  mediaSidecarHealth,
  mediaProbe,
  mediaCaptions,
  mediaAudio,
  mediaExtractAudio,
  mediaVideo,
  mediaDwgCrop,
  type DwgCrop,
  type DwgCropItem,
  type DwgCropSpec,
  type DwgCrops,
  type MediaResult,
  type MediaErrorCode,
  type MediaProbe,
  type MediaCaptions,
  type MediaBytes,
} from './media-sidecar';

export { MAX_UPLOAD_BYTES, maxStreamedUploadBytes } from './limits';

export {
  emailAttachmentFolders,
  emailAttachmentIds,
  reachesEmailAttachment,
} from './email-attachments';

export {
  filesRoot,
  isFilesPath,
  notAFilesFolder,
  diskPathForLtree,
  diskPathForFile,
  isSafeDiskBasename,
  ltreeForDiskPath,
  FILES_ROOT_LABEL,
  FILES_MAX_FOLDER_DEPTH,
  filesFolderDepth,
  assertFilesFolderDepth,
  clampFilesFolderPath,
} from './paths';

export {
  ensureRoot,
  ensureDir,
  readFile,
  deleteFile,
  renameFile,
  renameFolder,
  setFolderAside,
  isDiskChaff,
  strayFilesIn,
  diskNamesIn,
  untrackedFilesOnDisk,
  spoolUpload,
  discardSpooled,
  sweepSpool,
  sweepStagedLeftovers,
  STAGED_LEFTOVER_NAME,
  STAGED_LEFTOVER_MIN_AGE_MS,
  spoolDir,
  UploadTooLargeError,
  type SpooledUpload,
} from './disk';

export {
  SpacesRootUnavailableError,
  spacesRoot,
  spaceThumbsDir,
  spacesRootAvailable,
  spaceDir,
  spaceFilePath,
  foldedFilePath,
  spaceSpoolDir,
  adoptSpooledIntoSpace,
  openSpaceFile,
  readSpaceFile,
  removeSpaceFile,
} from './space-disk';

export {
  DOCS_ROOT_LABEL,
  CHANGELOG_COLLECTION_KEY,
  docsRoot,
  effectiveBrainDepth,
  collectionRoot,
  ltreeForDocPath,
  listMarkdownRelPaths,
  readMarkdownFile,
  isHiddenDocRelPath,
  upsertDocFromDisk,
  deleteDocByRelPath,
  diffDocSets,
  reconcileCollection,
  reconcileEnabledCollections,
  purgeCollection,
  ensureDefaultCollections,
  builtinDocCollections,
  listDocCollections,
  setCollectionEnabled,
  createDocCollection,
  type DiskDoc,
  type ReconcileResult,
} from './docs';

export {
  emptyDerivedCounts,
  derivedBucketForType,
  derivedCountsOf,
  describeDerivedCounts,
  type DerivedCounts,
} from './derived-counts';

export {
  AUTO_FILED_PATH,
  AUTO_FILED_SLUG,
  AUTO_FILED_SOURCES,
  autoFiledFolderPath,
  autoFiledMonth,
  autoFiledSourcePath,
  ensureAutoFiledFolder,
  ensureExtractedImagesFolder,
  reconcileAutoFiled,
  type AutoFiledReport,
  type AutoFiledSource,
} from './auto-filed';

export { exportFolder, saveExport, type SavedExport } from './export-home';

export {
  ensureFilesRootBranch,
  createFolder,
  ensureFolderPath,
  EXTRACTED_IMAGES_SLUG,
  updateFolderDescription,
  updateFolderLook,
  deleteFolder,
  renameFolderById,
  renamedFolderPath,
  FOLDER_NAME_MAX,
  folderDisplayName,
  listFolders,
  listAllFolders,
  listFoldersWithTrail,
  listAllFoldersWithTrail,
  folderById,
  folderByPath,
  upsertFile,
  readFileById,
  openFileById,
  BYTE_DERIVED_DATA_KEYS,
  deleteFileById,
  fileDeleteBlock,
  type FileDeleteBlock,
  renameFileById,
  bulkDeleteFiles,
  bulkDeleteGate,
  bulkRefusalOf,
  type BulkDeleteRefusal,
  listFiles,
  listRecentFiles,
  fileById,
  syncFileFromDisk,
  deleteFileByPath,
  fileNameTaken,
  FileNameTakenError,
  callerMayEditFolder,
  type FolderRow,
  type FileRow,
} from './ops';
// The files store's overwrite steps (A3b part 2: flipThenPlace), for the
// broker's DB tests to drive a race between two writers.
export { overwriteSteps } from './ops/files';
// A drawing check's crop (circuit_verify's evidence files): outside the
// ops barrel's pinned surface.
export { DRAWING_CHECK_PROVENANCE, isDrawingCheckCrop } from './ops/files';
export {
  ownIndexingMode,
  resolveEffectiveIndexing,
  metadataSpineText,
  setIndexingMode,
  type IndexingMode,
  type IndexingSetting,
  type EffectiveIndexing,
} from './indexing';
export {
  isThumbable,
  thumbnailFor,
  deleteThumbnailsFor,
  thumbsRoot,
  THUMB_MAX_DIM,
} from './thumbnail';
export {
  moveFileById,
  type MoveGuard,
  moveFolderById,
  copyFileById,
  copyFolderById,
  COPY_MAX_FILES,
} from './move-copy';
