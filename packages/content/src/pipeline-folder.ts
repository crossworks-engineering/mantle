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
 *  - writePackageFolder: the files of a version into a temporary folder
 *    inside the id's own folder (`<id>/.tmp-<uuid>`, a name no version
 *    has), then one rename, so the parser never sees half a folder. It
 *    writes a version that is not on disk: a live folder is never swapped.
 *    A test's draft is written in place (its folder is the test's own, and
 *    nothing reads it before the test sends its job). A file is 0644, a
 *    file under `bin/` 0755 (a ready-built program), a folder 0755, each
 *    set on the path itself (no umask takes a bit away).
 *  - removeOtherVersions: every name in an id's folder but the version in
 *    use and the one before it, so a job sent with the version before
 *    still finds its code. A temporary folder left by a crash goes here,
 *    at the next install of its id.
 *  - removePackageFolders: an id's folder in one rename to `.removed-<id>`,
 *    then that folder goes, then the id's drafts (a remove). A crash leaves
 *    the whole folder or none of it; a `.removed-<id>` left by a crash goes
 *    at the next remove of its id.
 *  - packageOnDisk: the version's `pipeline.json` is there (the registry's
 *    answer for a row whose files are gone, boxPipelines). diskAnswer
 *    gives it in a process with the folder, and nothing elsewhere.
 *
 * Every path is built by ownPackageDir (@mantle/files) from the checked
 * id and version only.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PIPELINE_DRAFTS,
  PIPELINE_ID,
  PIPELINE_MANIFEST_FILE,
  ownPackageDir,
  pipelinesDir,
  versionBelow,
} from '@mantle/files';

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

/** A new folder with its mode set (no umask takes a bit away). */
async function mkdirs(dir: string, stop: string): Promise<void> {
  if (dir === stop || (await exists(dir))) return;
  await mkdirs(path.dirname(dir), stop);
  await fs.mkdir(dir, { mode: 0o755 }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err;
  });
  await fs.chmod(dir, 0o755);
}

/** A new random word for a test's draft folder (DRAFT_WORD). */
export function draftWord(): string {
  return randomUUID().replace(/-/g, '');
}

/**
 * Write the files of one package into its folder (`draft`: the word of a
 * test's draft). A version: into a temporary folder in the id's folder,
 * then one rename; the caller writes only a version not on disk. Throws
 * when a write fails; the temporary folder goes then too.
 */
export async function writePackageFolder(
  id: string,
  version: string,
  files: ReadonlyMap<string, Buffer>,
  draft?: string,
): Promise<void> {
  const root = pipelinesDir();
  const dir = ownPackageDir(id, version, draft, root);
  if (!dir) throw new Error(`no folder for the package ${id} ${version}`);
  const tmp = draft ? dir : path.join(root, id, `.tmp-${randomUUID()}`);
  try {
    await mkdirs(tmp, root);
    for (const [file, bytes] of files) {
      const abs = path.join(tmp, file);
      await mkdirs(path.dirname(abs), tmp);
      await fs.writeFile(abs, bytes, { mode: modeOf(file) });
      await fs.chmod(abs, modeOf(file));
    }
    if (!draft) await fs.rename(tmp, dir);
  } finally {
    if (!draft) await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Remove the folders of `id` but the version `keep` and the highest
 *  version below it (the version before, which a job sent before the
 *  install may still run). */
export async function removeOtherVersions(id: string, keep: string): Promise<void> {
  const kept = ownPackageDir(id, keep);
  if (!kept) return;
  const idDir = path.dirname(kept);
  const names = await fs.readdir(idDir).catch(() => [] as string[]);
  let before: string | null = null;
  for (const name of names) {
    if (ownPackageDir(id, name) && versionBelow(name, keep)) {
      if (before === null || versionBelow(before, name)) before = name;
    }
  }
  for (const name of names) {
    if (name !== keep && name !== before) {
      await fs.rm(path.join(idDir, name), { recursive: true, force: true });
    }
  }
}

/** Remove the folder of `id` (every version) and its drafts: the folder
 *  in one rename, then the renamed one goes. */
export async function removePackageFolders(id: string): Promise<void> {
  const root = pipelinesDir();
  if (!PIPELINE_ID.test(id)) return;
  const gone = path.join(root, `.removed-${id}`);
  await fs.rm(gone, { recursive: true, force: true });
  await fs.rename(path.join(root, id), gone).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
  await fs.rm(gone, { recursive: true, force: true });
  const drafts = path.join(root, PIPELINE_DRAFTS);
  for (const name of await fs.readdir(drafts).catch(() => [] as string[])) {
    const word = name.startsWith(`${id}.`) ? name.slice(id.length + 1) : null;
    const dir = word === null ? null : ownPackageDir(id, null, word, root);
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Remove the draft folder of one test of `id` (the end of the test). */
export async function removeDraftFolder(id: string, word: string): Promise<void> {
  const draft = ownPackageDir(id, null, word);
  if (draft) await fs.rm(draft, { recursive: true, force: true });
}

/** Whether the files of `id` at `version` are on disk. */
export async function packageOnDisk(id: string, version: string): Promise<boolean> {
  const dir = ownPackageDir(id, version);
  return dir ? exists(path.join(dir, PIPELINE_MANIFEST_FILE)) : false;
}

/** The disk's answer for boxPipelines: packageOnDisk in a process with the
 *  folder (web), none in one without it, where the disk cannot say. */
export async function diskAnswer(): Promise<typeof packageOnDisk | undefined> {
  return (await pipelinesMounted()) ? packageOnDisk : undefined;
}
