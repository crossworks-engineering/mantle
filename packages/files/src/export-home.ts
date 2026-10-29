/**
 * Where an export lands: the one rule for every tool that saves a document,
 * a sheet or an app package for its caller (export_node, sheet_build,
 * app_export).
 *
 *  - The system, and a caller that may change the Files root and the
 *    Exports folder (the owner, an Admin user, in a scope that reads them):
 *    Auto-filed / Exports / <month>.
 *  - Anyone else (a member, or a scope that does not hold Admin, such as a
 *    workspace assistant's turn): the Files root, so the new file takes the
 *    create home a new item takes there (the call's workspace when the
 *    caller moderates it, else the caller's own private workspace; the
 *    database's mantle_default_home). Auto-filed is Admin only, so filing
 *    the export there left a member with a refusal or a file it could not
 *    open.
 *
 * An export never goes over a file. The Files root is one folder for every
 * workspace, so two members' exports (or one member's, twice) often share a
 * name: a taken name takes the next free one (`q1.xlsx`, `q1-2.xlsx`, ...),
 * the same whoever holds it, and nothing in the reply or a refusal names
 * the file that holds it.
 *
 * A tool whose export follows its source (present_export: one canvas, one
 * file every embed shows) stamps the file with that source (`data`) and
 * may ask to replace its earlier export (`replaceEarlier`): the newest file
 * the caller reads that carries the same source and name is written over in
 * place, wherever this rule put it (Auto-filed's month folders move on), so
 * the file id and every embed of it stay. Found none, a new file as above.
 *
 * The reply names where the file landed (landedIn), as a create's does: read
 * in the caller's scope; a turn of a workspace the caller only reads cannot
 * read its private workspace, so there it names the call's private create
 * home (the one place outside that scope the file can land). Nothing here
 * grants: what the export holds is the tool's to read in the
 * caller's scope, and the database's create checks still run.
 */
import { promises as fsp } from 'node:fs';
import { and, desc, eq, sql } from 'drizzle-orm';
import { currentCreateHome, db, landedIn, nodes } from '@mantle/db';
import { ConflictError } from '@mantle/std';
import { AUTO_FILED_PATH, ensureAutoFiledFolder } from './auto-filed';
import { discardSpooled, type SpooledUpload } from './disk';
import { FILES_ROOT_LABEL } from './paths';
import { sanitizeFilename } from './slug';
import { callerMayEditFolder, fileNameTaken, upsertFile } from './ops/files';
import { ensureFilesRootBranch } from './ops/shared';
import type { FileRow } from './ops/shared';

/** The folder an export of the current caller goes into, made if missing:
 *  its ltree path, and whether it is Auto-filed. */
export async function exportFolder(ownerId: string): Promise<{ path: string; autoFiled: boolean }> {
  await ensureFilesRootBranch(ownerId);
  // Auto-filed's folders are made under the Files root in the caller's
  // scope: only a caller that may change the root may make them.
  if ((await callerMayEditFolder(ownerId, FILES_ROOT_LABEL)) !== false) {
    const path = await ensureAutoFiledFolder(ownerId, 'exports');
    if ((await callerMayEditFolder(ownerId, path)) !== false) return { path, autoFiled: true };
  }
  return { path: FILES_ROOT_LABEL, autoFiled: false };
}

/** A saved export: the file, whether it went to Auto-filed, and the
 *  workspace it landed in (null when the caller's scope cannot read it). */
export type SavedExport = {
  file: FileRow;
  autoFiled: boolean;
  landedIn: { id: string; name: string } | null;
};

/** How many names an export tries: its own, then `-2` up to `-<this>`,
 *  then one with a time stamp. */
export const EXPORT_NAME_TRIES = 20;

/** The names an export tries, in order (sanitized as upsertFile does): its
 *  own, then `<stem>-2.<ext>` and on, then `<stem>-<time>.<ext>`. */
export function exportNames(filename: string): string[] {
  const clean = sanitizeFilename(filename);
  // An invalid name: upsertFile refuses it with its own words.
  if (!clean) return [filename];
  const dot = clean.lastIndexOf('.');
  const stem = (dot > 0 ? clean.slice(0, dot) : clean).slice(0, 160);
  const ext = dot > 0 ? clean.slice(dot) : '';
  const names = [clean];
  for (let i = 2; i <= EXPORT_NAME_TRIES; i++) names.push(`${stem}-${i}${ext}`);
  names.push(`${stem}-${Date.now().toString(36)}${ext}`);
  return names;
}

/** Save an export for the current caller where exportFolder says. Exactly
 *  one of `bytes` / `spooled`. Never over a file: a name already taken in
 *  the folder (the caller's own export, or a file it cannot see; the Files
 *  root is one folder for every workspace) takes the next free name
 *  (exportNames), and the reply and its refusals read the same whoever
 *  holds the name. A spooled upload is removed on every failure. */
export async function saveExport(args: {
  ownerId: string;
  filename: string;
  bytes?: Buffer;
  spooled?: SpooledUpload;
  /** Keys merged onto the file's data: what it is an export of. */
  data?: { exportOf?: string } & Record<string, unknown>;
  /** Write over the caller's earlier export of `data.exportOf` with this
   *  name, wherever it is (see the module comment). */
  replaceEarlier?: boolean;
}): Promise<SavedExport> {
  let saved: { file: FileRow; autoFiled: boolean };
  try {
    saved = (await replaceEarlierExport(args)) ?? (await saveUnderFreeName(args));
  } catch (err) {
    if (args.spooled) await discardSpooled(args.spooled);
    throw err;
  }
  // The file is made: a landedIn read that fails names no workspace (as
  // MCP's withLanding does), never fails the export.
  let home: { id: string; name: string } | undefined;
  try {
    [home] = await landedIn([saved.file.id]);
  } catch {
    return { ...saved, landedIn: null };
  }
  return { ...saved, landedIn: home ?? privateLanding(saved.autoFiled) };
}

/** The newest file the caller reads (the call's scope) that is an export
 *  of `exportOf` named `filename`: its folder, or null. */
export async function earlierExportFolder(
  ownerId: string,
  exportOf: string,
  filename: string,
): Promise<string | null> {
  const name = sanitizeFilename(filename);
  if (!name) return null;
  const [hit] = await db
    .select({ path: nodes.path })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.data}->>'exportOf' = ${exportOf}`,
        sql`${nodes.data}->>'filename' = ${name}`,
      ),
    )
    .orderBy(desc(nodes.updatedAt))
    .limit(1);
  return hit ? String(hit.path) : null;
}

/** The earlier export written over in place, when asked for and found. */
async function replaceEarlierExport(args: {
  ownerId: string;
  filename: string;
  bytes?: Buffer;
  spooled?: SpooledUpload;
  data?: { exportOf?: string } & Record<string, unknown>;
  replaceEarlier?: boolean;
}): Promise<{ file: FileRow; autoFiled: boolean } | null> {
  const of = args.data?.exportOf;
  if (!args.replaceEarlier || !of) return null;
  const folder = await earlierExportFolder(args.ownerId, of, args.filename);
  if (!folder) return null;
  const file = await upsertFile({
    ownerId: args.ownerId,
    parentPath: folder,
    filename: args.filename,
    ...(args.spooled ? { spooled: args.spooled } : { bytes: args.bytes }),
    data: args.data,
    overwrite: true,
  });
  const autoFiled = folder === AUTO_FILED_PATH || folder.startsWith(`${AUTO_FILED_PATH}.`);
  return { file, autoFiled };
}

async function saveUnderFreeName(args: {
  ownerId: string;
  filename: string;
  bytes?: Buffer;
  spooled?: SpooledUpload;
  data?: Record<string, unknown>;
}): Promise<{ file: FileRow; autoFiled: boolean }> {
  const folder = await exportFolder(args.ownerId);
  for (const filename of exportNames(args.filename)) {
    // Existence only, whatever the caller's scope (structure): a taken
    // name is passed over before the disk, so upsertFile never meets it.
    if (await fileNameTaken(args.ownerId, folder.path, filename)) continue;
    try {
      const file = await upsertFile({
        ownerId: args.ownerId,
        parentPath: folder.path,
        filename,
        ...(args.spooled ? { spooled: args.spooled } : { bytes: args.bytes }),
        ...(args.data ? { data: args.data } : {}),
      });
      return { file, autoFiled: folder.autoFiled };
    } catch (err) {
      // A create that took the name in between: the next one, while the
      // spooled bytes are still there (a lost race after staging drops them).
      if (!(err instanceof ConflictError)) throw err;
      if (args.spooled && !(await spoolThere(args.spooled))) throw exportRaceError();
    }
  }
  throw exportNameError(args.filename);
}

/** The one refusal when no name is free: the caller's own name, nothing of
 *  the files that hold the others. */
function exportNameError(filename: string): ConflictError {
  return new ConflictError(
    `export: no free name for '${filename}' in this folder; try again with another filename`,
  );
}

/** A spooled package that lost a name race after it was staged: its bytes
 *  are gone, so it cannot take the next name. Free names may remain. */
function exportRaceError(): ConflictError {
  return new ConflictError('export: the name was taken while saving; try again');
}

async function spoolThere(spooled: SpooledUpload): Promise<boolean> {
  return fsp.access(spooled.tempPath).then(
    () => true,
    () => false,
  );
}

/** What landedIn names for a file the caller's scope cannot read: its
 *  private create home, when the call has one (see the module comment). */
export const PRIVATE_LANDING_NAME = 'your private workspace (only you)';

function privateLanding(autoFiled: boolean): { id: string; name: string } | null {
  const ws = autoFiled ? null : (currentCreateHome()?.privateWs ?? null);
  return ws ? { id: ws, name: PRIVATE_LANDING_NAME } : null;
}
