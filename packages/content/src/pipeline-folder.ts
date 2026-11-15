/**
 * The ONE writer of the folder of own packages (docs/pipelines.md, "Own
 * pipelines"): web writes it, the parser reads it from its read-only
 * mount, and no other process touches it. The row (pipeline_state.package)
 * is the store; a folder is a copy written from the same input, so a
 * missing folder is fixed by an install of the same files.
 *
 *  - pipelinesMounted: the root is there. Web never makes the root itself,
 *    so on a box whose compose file lacks the mount no write lands in the
 *    container's own layer: the install refuses (NO_MOUNT).
 *  - writePackageFolder: the files of a version, or of a test's draft,
 *    into a temporary name under the root, then one rename, so the parser
 *    never sees half a folder. A file is 0644, a file under `bin/` 0755 (a
 *    ready-built program). A rename that fails leaves no half folder.
 *  - removeOtherVersions: the folders of an id but the version in use.
 *  - removePackageFolders: an id's folder and its draft (a remove).
 *  - packageOnDisk: the version's `pipeline.json` is there (the list's
 *    check of a row whose files are gone).
 *
 * Every path is built by ownPackageDir (@mantle/files) from the checked
 * id and version only.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PIPELINE_MANIFEST_FILE, ownPackageDir, pipelinesDir } from '@mantle/files';

/** The refusal of a box with no pipelines folder. */
export const NO_MOUNT =
  'This box has no pipelines folder: its compose file lacks the mount. See docs/pipelines.md, Own pipelines.';

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}

/** Whether the root of the own packages is there. */
export function pipelinesMounted(): Promise<boolean> {
  return exists(pipelinesDir());
}

/** The mode of a file of a package: a program under `bin/` runs. */
function modeOf(file: string): number {
  return file.startsWith('bin/') ? 0o755 : 0o644;
}

/**
 * Write the files of one package into its folder (`draft`: the draft of a
 * test), whole: into a temporary folder under the root, then one rename
 * over the folder there. Throws when a write fails; the temporary folder
 * goes then too.
 */
export async function writePackageFolder(
  id: string,
  version: string,
  files: ReadonlyMap<string, Buffer>,
  draft = false,
): Promise<void> {
  const root = pipelinesDir();
  const dir = ownPackageDir(id, version, draft, root);
  if (!dir) throw new Error(`no folder for the package ${id} ${version}`);
  const tmp = path.join(root, `.tmp-${randomUUID()}`);
  try {
    for (const [file, bytes] of files) {
      const abs = path.join(tmp, file);
      await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o755 });
      await fs.writeFile(abs, bytes, { mode: modeOf(file) });
      // The process umask must not take the mode's bits away.
      await fs.chmod(abs, modeOf(file));
    }
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o755 });
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(tmp, dir);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Remove the folders of `id` but the version `keep`. */
export async function removeOtherVersions(id: string, keep: string): Promise<void> {
  const kept = ownPackageDir(id, keep);
  if (!kept) return;
  const idDir = path.dirname(kept);
  const names = await fs.readdir(idDir).catch(() => [] as string[]);
  for (const name of names) {
    if (name !== keep) await fs.rm(path.join(idDir, name), { recursive: true, force: true });
  }
}

/** Remove the folder of `id` (every version) and its draft. */
export async function removePackageFolders(id: string): Promise<void> {
  const root = pipelinesDir();
  const draft = ownPackageDir(id, null, true, root);
  if (!draft) return;
  await fs.rm(path.join(root, id), { recursive: true, force: true });
  await fs.rm(draft, { recursive: true, force: true });
}

/** Remove the draft folder of `id` (the end of a test). */
export async function removeDraftFolder(id: string): Promise<void> {
  const draft = ownPackageDir(id, null, true);
  if (draft) await fs.rm(draft, { recursive: true, force: true });
}

/** Whether the files of `id` at `version` are on disk. */
export async function packageOnDisk(id: string, version: string): Promise<boolean> {
  const dir = ownPackageDir(id, version);
  return dir ? exists(path.join(dir, PIPELINE_MANIFEST_FILE)) : false;
}
