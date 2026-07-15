import path from 'node:path';

/**
 * Storage layout: one sqlite workbook file per Table node —
 *   ${TABLE_DB_DIR}/<ownerId>/<nodeId>.sqlite          (published)
 *   ${TABLE_DB_DIR}/<ownerId>/<nodeId>.draft.sqlite    (working copy)
 *
 * TABLE_DB_DIR is /data/table-dbs in prod (bind-mounted into web AND api —
 * both processes execute tool handlers). Bare full-stack dev falls back to a
 * cwd-relative .table-dbs, mirroring app-broker's APP_DB_DIR convention.
 */

export function tableDbRoot(): string {
  return process.env.TABLE_DB_DIR ?? path.join(process.cwd(), '.table-dbs');
}

/** Ids come from our own DB (UUIDs), but never trust them as path segments. */
function safeSegment(id: string, label: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`tabledb: unsafe ${label} for a path segment: ${JSON.stringify(id)}`);
  return id;
}

export function publishedPath(ownerId: string, nodeId: string, root = tableDbRoot()): string {
  return path.join(root, safeSegment(ownerId, 'ownerId'), `${safeSegment(nodeId, 'nodeId')}.sqlite`);
}

export function draftPath(ownerId: string, nodeId: string, root = tableDbRoot()): string {
  return path.join(root, safeSegment(ownerId, 'ownerId'), `${safeSegment(nodeId, 'nodeId')}.draft.sqlite`);
}

/** The registry's storage_path holds a ROOT-RELATIVE published path (e.g.
 *  "<owner>/<node>.sqlite") so a box can relocate TABLE_DB_DIR without a data
 *  migration. Resolve it under the current root, refusing traversal. */
export function resolveStoragePath(storagePath: string, root = tableDbRoot()): string {
  const abs = path.resolve(root, storagePath);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`tabledb: storage_path escapes TABLE_DB_DIR: ${JSON.stringify(storagePath)}`);
  }
  return abs;
}

export function relativeStoragePath(ownerId: string, nodeId: string): string {
  return `${safeSegment(ownerId, 'ownerId')}/${safeSegment(nodeId, 'nodeId')}.sqlite`;
}

/** Draft file sits beside the published file: same name + .draft.sqlite. */
export function draftPathFor(publishedAbs: string): string {
  if (!publishedAbs.endsWith('.sqlite')) throw new Error('tabledb: expected a .sqlite path');
  return `${publishedAbs.slice(0, -'.sqlite'.length)}.draft.sqlite`;
}
