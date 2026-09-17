/**
 * Files surface: the high-level operations that the API routes, the
 * MCP tools, and the future folder watcher all go through. Pairs every
 * DB mutation with the matching filesystem write so the two stay in
 * lockstep.
 *
 * Tree model:
 *   - `files` is the root ltree label and the only one we mirror to disk.
 *   - Folders are `nodes.type='branch'` rows. `data.description` is free
 *     text; `data.slug` is the kebab disk-name (because ltree labels
 *     can't carry a dash).
 *   - Files are `nodes.type='file'` rows. `data.filename` carries the basename
 *     **exactly as it appears on disk** — it is what `diskPathForFile`
 *     reconstructs the path from, so it cannot be a transform of the real name.
 *     Uploads (`upsertFile`) sanitise, because they choose the name and then
 *     write the bytes under it; the disk watcher (`syncFileFromDisk`) preserves,
 *     because the file is already there under a name the operator chose.
 *     `data.content` is populated for text files so the extractor / editor
 *     don't need a disk round-trip.
 */

export { ensureFilesRootBranch, type FolderRow, type FileRow } from './ops/shared';
export {
  upsertFile,
  readFileById,
  countDerivedFromFile,
  drawsReferencingFile,
  deleteFileById,
  syncFileFromDisk,
  deleteFileByPath,
  renameFileById,
  bulkDeleteFiles,
} from './ops/files';
export { listRecentFiles, listFiles, folderById, folderByPath, fileById } from './ops/queries';
export {
  createFolder,
  ensureDatedUploadFolder,
  ensureExtractedImagesFolder,
  EXTRACTED_IMAGES_SLUG,
  ensureFolderPath,
  updateFolderDescription,
  deleteFolder,
  listFolders,
  listAllFolders,
  renamedFolderPath,
  renameFolderById,
} from './ops/folders';
