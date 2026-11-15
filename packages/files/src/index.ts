export {
  folderSlugOf,
  slugifyFolder,
  sanitizeFilename,
  dashToLtree,
  ltreeToDash,
  extOf,
  mimeForExt,
  TEXT_EXTS,
  ANYDOC_EXTS,
  MARKUP_EXTS,
  LEGACY_SHEET_EXTS,
  INGESTABLE_EXTS,
  MEDIA_EXTS,
  PREVIEWABLE_MARKDOWN_EXTS,
  EXPORT_REQUIRED_EXTS,
  exportHintForExt,
  parserRouteForExt,
  isVisionImage,
  CAD_EXTS,
  CAD_NAME_PATTERN,
  isCadExt,
  isDrawingExt,
  extractWeightOfExt,
  type CadExt,
  type ExtractWeight,
  type ParserRoute,
} from './slug';

export { isHeic, transcodeImageForVision } from './transcode';

export { parseDocumentBytes } from './parse';

// The one client for the parser service (server/parser): every untrusted
// file the brain reads goes through it.
export {
  ParserError,
  isParserError,
  isParserUnavailable,
  parserText,
  parserImages,
  parserGrid,
  parserRasterizePdf,
  parserPdfPageCount,
  parserPdfDrawing,
  parserPdfPieces,
  parserPdfUnlock,
  parserThumbnail,
  parserImageForVision,
  parserExtractAudio,
  parserHealth,
  parserFailureKey,
  parserPipelineRun,
  type ParserPipelineStep,
  resetParserFailures,
  withParserScope,
  type ParserErrorCode,
  type ParserFailureCount,
  type ParserFailureLedger,
  type ParserResult,
  type ParserHealth,
  type ParserGrid,
  type PdfPasswordResult,
} from './parser-client';
export { PARSER_COUNTED_CODES } from './parser-wire';
export { keptReaderRun, memoReaderRun, readerRunKey, READER_MEMO_MAX } from './reader-memo';
export {
  parserDwgCrop,
  type DwgCrop,
  type DwgCropItem,
  type DwgCropSpec,
  type DwgCrops,
  type DwgFrame,
  type DgnFacts,
  type DwgRender,
  type DwgViewItem,
  type DwgViewSpec,
  type DwgWindow,
} from './parser-cad';

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

export { readFileNodeBytes, loadFileHead } from './file-read';
export type { FileReadNode, LoadedFileBytes } from './file-read';
export {
  filesRootMounted,
  FILE_DB_NONE_WORDS,
  fileDbNameExists,
  fileDbPaths,
  fileDbSqlitePath,
  fileDbsDir,
  fileDbsWritable,
  fileIdsWithDatabase,
  fileSha256Of,
  fileDbWordOf,
  isFileSha256,
  listFileDbFolder,
  readFileDbNone,
  readFileDbNoneStamp,
  removeFileDbEntry,
  removeFileDbNames,
  removeFileDbNamesAfterCommit,
  removeFileDbNone,
  removeOtherFileDbNames,
  writeFileDbNone,
} from './file-dbs';
export type { FileDbNoneWord } from './file-dbs';
// The pipeline contract and the built-in readers that make a file's
// database (docs/pipelines.md).
export {
  FILE_TABS_WRITE,
  PIPELINE_DESCRIPTION_MAX,
  PIPELINE_API,
  PIPELINE_MANIFEST_FILE,
  PIPELINE_PACKAGE_FILES_MAX,
  PIPELINE_PACKAGE_MAX_BYTES,
  PIPELINE_STEPS_MAX,
  type PipelinePackage,
  type PipelinePackageFile,
  type PipelineCall,
  type PipelineCallAnswer,
  type PipelineInput,
  type PipelineKind,
  type PipelineManifest,
  type PipelineOptionSpec,
  type PipelineRuntime,
  type PipelineSource,
  type PipelineStamp,
  type PipelineStart,
  type PipelineStepRequest,
  type PipelineStepResult,
  type ShapeId,
} from './pipelines/contract';
export {
  BUILTIN_PIPELINES,
  PIPELINE_STAMP_KEYS,
  afterMatches,
  dbExtsOf,
  defaultState,
  isAfterPipeline,
  isReader,
  isRouter,
  pipelineStampOf,
  readerFor,
  readersByExt,
  routerFor,
  versionBelow,
  type AfterId,
  type AfterPipeline,
  type BuiltinId,
  type BuiltinPipeline,
  type ReaderId,
  type RouterPipeline,
  type ReaderPipeline,
} from './pipelines/builtin';
export {
  checkManifest,
  PIPELINE_ID,
  PIPELINE_TIME_MAX_MS,
  type ManifestCheck,
} from './pipelines/manifest-check';
export { checkPackage, packageHash, type PackageCheck } from './pipelines/package-check';
export { DRAFT_WORD, PIPELINE_DRAFTS, ownPackageDir, pipelinesDir } from './pipelines/own-folder';
export {
  afterEntryOf,
  afterEntryIn,
  afterIsCurrent,
  pipelineReadOf,
  readerIsCurrent,
  stampOfMeta,
  withAfterEntry,
  type FileDbSeen,
} from './pipelines/stamp';
export type { SiteProfile } from './pdf-tags';
export { checkOptions, effectiveOptions, optionsHash } from './pipelines/options';
export {
  AFTER_CELL_MAX_CHARS,
  SHAPES,
  shapesOf,
  type Shape,
  type ShapeTab,
} from './pipelines/shapes';
// The runner of packaged pipelines (docs/pipelines.md, "The runner").
export {
  PIPELINE_KIT,
  PIPELINE_CALLS_MAX,
  PIPELINE_KIND_MAX_CHARS,
  PIPELINE_STATE_MAX_BYTES,
  type FileTabsWriteInput,
  type PipelineStep,
  type StepJob,
} from './pipelines/contract';
export { checkStepResult } from './pipelines/step-check';
export { tabHeadLine, tabRowLine, tabRowsOf } from './pipelines/tabs-body';
export {
  extractorRefusesFile,
  fileDataExt,
  fileDataListKeys,
  fileDataRefusal,
  fileDataRefusals,
  fileDataRow,
  fileDataRows,
  fileDataRowsIn,
  tableFileFilter,
  tableNamingFile,
  withDataView,
  type FileDataRefusal,
  type FileDataRow,
} from './file-data';
export {
  DATA_FILES_MAX,
  DATA_FILES_UNDER,
  listDataFiles,
  type DataFileRow,
  type DataFileState,
} from './file-db-list';

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
  isPngBytes,
  listScreenshots,
  PNG_HEADER_BYTES,
  pngDimensions,
  saveScreenshotFile,
  screenshotById,
  screenshotFilename,
  screenshotTooLarge,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MAX_PIXELS,
  SCREENSHOT_MAX_SIDE,
  SCREENSHOT_TAG,
  type SavedScreenshot,
  type Screenshot,
  type ScreenshotSummary,
} from './screenshots';

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
  filesByIds,
  syncFileFromDisk,
  deleteFileByPath,
  fileNameTaken,
  FileNameTakenError,
  callerMayEditFolder,
  type FolderRow,
  type FileRow,
} from './ops';
// The files store's overwrite steps (flipThenPlace), for the
// broker's DB tests to drive a race between two writers.
export { overwriteSteps } from './ops/files';
// A drawing check's crop (circuit_verify's evidence files): outside the
// ops barrel's pinned surface.
export { DRAWING_CHECK_PROVENANCE, isDrawingCheckCrop } from './ops/files';
export {
  ownIndexingMode,
  privateFileIds,
  privateByFlags,
  flaggedFolders,
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

export type { PdfDrawing, PdfDrawingPage } from './pdf-drawing';
export { PDF_KINDS, PAGE_KINDS, type PdfKind, type PageKind, type PageFacts } from './pdf-kind';
export {
  CLOCK_COLUMNS,
  PDF_KIND_RULES_VERSION,
  pdfDrawingSheets,
  pdfFileTabOf,
  pdfKindAskFrom,
  pdfKindAskOf,
  pdfReadPoorer,
  pagesNotReadWhole,
  type PdfDrawingSheets,
  type PdfKindAsk,
  type PdfKindDecision,
} from './pdf-drawing-sheets';
export {
  SKETCH_KINDS,
  SKETCH_MAX_PAGES,
  SKETCH_PROMPT,
  parsePieceAnswer,
  sketchMarkdown,
  sketchPageRead,
  sketchPagesOf,
  type SketchPagePieces,
  type SketchPageRead,
  type SketchRead,
} from './pdf-sketch';
export { TITLE_BLOCK_MM, titleBlockOf, type TitleBlockMm } from './pdf-rows';
