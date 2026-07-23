export {
  slugifyFolder,
  sanitizeFilename,
  dashToLtree,
  ltreeToDash,
  extOf,
  mimeForExt,
  TEXT_EXTS,
  TIKA_EXTS,
  INGESTABLE_EXTS,
  PREVIEWABLE_MARKDOWN_EXTS,
  parserRouteForExt,
  type ParserRoute,
} from './slug';

export { isHeic, transcodeImageForVision } from './transcode';

export { parseDocumentBytes } from './parse';

export { extractPdfTextWithPassword, type PdfPasswordResult } from './pdf-password';

export { parseTikaBytes, tikaIsUp, tikaVersion } from './tika';

export { MAX_UPLOAD_BYTES } from './limits';

export {
  filesRoot,
  quarantineRoot,
  isFilesPath,
  diskPathForLtree,
  diskPathForFile,
  ltreeForDiskPath,
  FILES_ROOT_LABEL,
} from './paths';

export {
  quarantinePathFor,
  writeQuarantineBytes,
  readQuarantineBytes,
  deleteQuarantineBytes,
  listQuarantineBlobIds,
} from './quarantine';

export {
  ensureRoot,
  ensureDir,
  writeFile,
  readFile,
  deleteFile,
  renameFile,
  renameFolder,
  removeFolder,
} from './disk';

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
  ensureFilesRootBranch,
  createFolder,
  ensureDatedUploadFolder,
  updateFolderDescription,
  deleteFolder,
  renameFolderById,
  renamedFolderPath,
  listFolders,
  listAllFolders,
  folderById,
  folderByPath,
  upsertFile,
  readFileById,
  deleteFileById,
  renameFileById,
  bulkDeleteFiles,
  listFiles,
  fileById,
  syncFileFromDisk,
  deleteFileByPath,
  type FolderRow,
  type FileRow,
} from './ops';
