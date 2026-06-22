/**
 * Web's view onto the shared file ops in `@mantle/files`. Kept as a
 * thin re-export so the API routes can import from `@/lib/files` (the
 * project convention) while the actual implementation lives in the
 * workspace package so apps/mcp can call the same functions.
 */

export {
  ensureFilesRootBranch,
  createFolder,
  updateFolderDescription,
  renameFolderById,
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
  type FolderRow,
  type FileRow,
} from '@mantle/files';
