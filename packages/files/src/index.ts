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

export { tikaIsUp, tikaVersion } from './tika';

export { MAX_UPLOAD_BYTES } from './limits';

export {
  filesRoot,
  isFilesPath,
  diskPathForLtree,
  diskPathForFile,
  ltreeForDiskPath,
  FILES_ROOT_LABEL,
} from './paths';

export {
  ensureRoot,
  ensureDir,
  writeFile,
  readFile,
  deleteFile,
  renameFile,
  removeFolder,
} from './disk';

export {
  DOCS_ROOT_LABEL,
  docsRoot,
  effectiveBrainDepth,
  collectionRoot,
  ltreeForDocPath,
  listMarkdownRelPaths,
  readMarkdownFile,
  upsertDocFromDisk,
  deleteDocByRelPath,
  diffDocSets,
  reconcileCollection,
  reconcileEnabledCollections,
  purgeCollection,
  ensureDefaultCollections,
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
