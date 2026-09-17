import { describe, it, expect } from 'vitest';
import * as ops from './ops';

/**
 * ops.ts was one 1360-line module; it is now a CURATED barrel over
 * ops/{shared,files,queries,folders}.ts.
 *
 * Splitting forced three module-private helpers (folderCounts,
 * folderRowFromNode, fileRowFromNode) into cross-module scope. They are
 * exported from ops/shared.ts so the sibling modules can reach them, and
 * they must NOT reach the barrel: `folderCounts` runs the child/file count
 * subqueries a caller would otherwise duplicate, and the two row mappers
 * decide which node fields become public row shape. Publishing them invites
 * a caller to build rows that skip the mapper.
 *
 * So the barrel is `export { ... }` per module, never `export *`. This test
 * fails both ways: relaxing to `export *` leaks the three, and dropping a
 * real export breaks a consumer.
 */
const PUBLIC = [
  // ops/shared.ts
  'ensureFilesRootBranch',
  // ops/files.ts
  'upsertFile',
  'readFileById',
  'countDerivedFromFile',
  'drawsReferencingFile',
  'deleteFileById',
  'syncFileFromDisk',
  'deleteFileByPath',
  'renameFileById',
  'bulkDeleteFiles',
  // ops/queries.ts
  'listRecentFiles',
  'listFiles',
  'folderById',
  'folderByPath',
  'fileById',
  // ops/folders.ts
  'createFolder',
  'ensureDatedUploadFolder',
  'ensureExtractedImagesFolder',
  'EXTRACTED_IMAGES_SLUG',
  'ensureFolderPath',
  'updateFolderDescription',
  'deleteFolder',
  'listFolders',
  'listAllFolders',
  'renamedFolderPath',
  'renameFolderById',
] as const;

/** Exported from ops/shared.ts for the siblings only. */
const MUST_STAY_INTERNAL = ['folderCounts', 'folderRowFromNode', 'fileRowFromNode'] as const;

describe('ops.ts barrel', () => {
  it('exports exactly the pre-split public surface', () => {
    expect(Object.keys(ops).sort()).toEqual([...PUBLIC].sort());
  });

  it('does not republish the helpers the split exposed', () => {
    for (const name of MUST_STAY_INTERNAL) {
      expect(Object.keys(ops), name).not.toContain(name);
    }
  });
});
