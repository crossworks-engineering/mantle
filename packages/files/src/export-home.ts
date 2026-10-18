/**
 * Where an export lands: the one rule for every tool that saves a document,
 * a sheet or an app package for its caller (export_node, sheet_build,
 * app_export).
 *
 *  - The system, the owner and an Admin user who may change the Exports
 *    folder: Auto-filed / Exports / <month>, as before.
 *  - Anyone else (a member, or a scope that does not hold Admin, such as a
 *    workspace assistant's turn): the Files root, so the new file takes the
 *    create home a new item takes there (the call's workspace when the
 *    caller moderates it, else the caller's own private workspace; the
 *    database's mantle_default_home). Auto-filed is Admin only, so filing
 *    the export there left a member with a refusal or a file it could not
 *    open.
 *
 * The reply names where the file landed (landedIn), as a create's does.
 * Nothing here grants: what the export holds is the tool's to read in the
 * caller's scope, and the database's create checks still run.
 */
import { landedIn, scopeHoldsAdmin } from '@mantle/db';
import { ensureAutoFiledFolder } from './auto-filed';
import { discardSpooled, type SpooledUpload } from './disk';
import { FILES_ROOT_LABEL } from './paths';
import { callerMayEditFolder, upsertFile } from './ops/files';
import { ensureFilesRootBranch } from './ops/shared';
import type { FileRow } from './ops/shared';

/** The folder an export of the current caller goes into, made if missing:
 *  its ltree path, and whether it is Auto-filed. */
export async function exportFolder(ownerId: string): Promise<{ path: string; autoFiled: boolean }> {
  if (await scopeHoldsAdmin()) {
    const path = await ensureAutoFiledFolder(ownerId, 'exports');
    if ((await callerMayEditFolder(ownerId, path)) !== false) return { path, autoFiled: true };
  }
  await ensureFilesRootBranch(ownerId);
  return { path: FILES_ROOT_LABEL, autoFiled: false };
}

/** A saved export: the file, whether it went to Auto-filed, and the
 *  workspace it landed in (null when the caller's scope cannot read it). */
export type SavedExport = {
  file: FileRow;
  autoFiled: boolean;
  landedIn: { id: string; name: string } | null;
};

/** Save an export for the current caller where exportFolder says. Exactly
 *  one of `bytes` / `spooled`; a spooled upload is removed when the folder
 *  cannot be made. */
export async function saveExport(args: {
  ownerId: string;
  filename: string;
  bytes?: Buffer;
  spooled?: SpooledUpload;
}): Promise<SavedExport> {
  let folder: Awaited<ReturnType<typeof exportFolder>>;
  try {
    folder = await exportFolder(args.ownerId);
  } catch (err) {
    if (args.spooled) await discardSpooled(args.spooled);
    throw err;
  }
  const file = await upsertFile({
    ownerId: args.ownerId,
    parentPath: folder.path,
    filename: args.filename,
    ...(args.spooled ? { spooled: args.spooled } : { bytes: args.bytes }),
  });
  const [home] = await landedIn([file.id]);
  return { file, autoFiled: folder.autoFiled, landedIn: home ?? null };
}
