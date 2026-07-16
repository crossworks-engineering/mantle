import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Storage layout: one sqlite workbook file per Table node —
 *   ${TABLE_DB_DIR}/<ownerId>/<nodeId>.sqlite          (published)
 *   ${TABLE_DB_DIR}/<ownerId>/<nodeId>.draft.sqlite    (working copy)
 *
 * TABLE_DB_DIR is /data/table-dbs in prod (bind-mounted into web AND api —
 * both processes execute tool handlers). When unset (bare full-stack dev) we
 * anchor to a SINGLE monorepo-root `.table-dbs` so every workspace process
 * resolves the same directory. The previous cwd-relative default split web
 * (cwd apps/web) and api (cwd apps/api) into two roots, so a workbook the agent
 * wrote under apps/api/.table-dbs was "missing" when the web UI read
 * apps/web/.table-dbs — a guaranteed 500 on every table open in local dev, and
 * on any deployed box whose compose predates the table-dbs mount (TABLE_DB_DIR
 * unset). Prod always sets TABLE_DB_DIR, so the walk below is a dev-only path.
 */

let cachedDefaultRoot: string | undefined;

/** Nearest ancestor dir containing pnpm-workspace.yaml = the monorepo root.
 *  Falls back to cwd when the marker isn't found (e.g. a bundled runtime with
 *  no source tree — but such deployments set TABLE_DB_DIR explicitly). */
function defaultTableDbRoot(): string {
  if (cachedDefaultRoot) return cachedDefaultRoot;
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }
  let root = process.cwd();
  for (let cur = dir; ; ) {
    if (fs.existsSync(path.join(cur, 'pnpm-workspace.yaml'))) {
      root = cur;
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  cachedDefaultRoot = path.join(root, '.table-dbs');
  return cachedDefaultRoot;
}

export function tableDbRoot(): string {
  return process.env.TABLE_DB_DIR ?? defaultTableDbRoot();
}

/** Ids come from our own DB (UUIDs), but never trust them as path segments. */
function safeSegment(id: string, label: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(id))
    throw new Error(`tabledb: unsafe ${label} for a path segment: ${JSON.stringify(id)}`);
  return id;
}

export function publishedPath(ownerId: string, nodeId: string, root = tableDbRoot()): string {
  return path.join(
    root,
    safeSegment(ownerId, 'ownerId'),
    `${safeSegment(nodeId, 'nodeId')}.sqlite`,
  );
}

export function draftPath(ownerId: string, nodeId: string, root = tableDbRoot()): string {
  return path.join(
    root,
    safeSegment(ownerId, 'ownerId'),
    `${safeSegment(nodeId, 'nodeId')}.draft.sqlite`,
  );
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
