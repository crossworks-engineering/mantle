/**
 * The disk home of personal-space file bytes (member logins Phase 2, plan
 * v3.1 section 2: "file bytes have no owner segment").
 *
 * Brain files mirror their ltree path under MANTLE_FILES_ROOT, and the
 * external-edit watcher files anything it finds there as the brain's. A
 * personal file must never land there. So its bytes live in a SEPARATE root,
 * keyed by space and node id, never by path or name:
 *
 *   ${MANTLE_SPACES_ROOT}/<spaceId>/files/<nodeId>
 *
 * The filename is metadata on the node (a rename touches no disk), and a
 * personal file's node path is not under `files`, so every brain file helper
 * (`diskPathForLtree`, `readFileById`, the watcher) resolves nothing for it:
 * a forgotten path stays blind.
 *
 * Tables need no help here: their workbooks already sit under
 * TABLE_DB_DIR/<ownerId>/, and a personal table's owner is its space.
 *
 * MANTLE_SPACES_ROOT is its own bind mount in production (docker-compose.yml)
 * and scripts/db-dump.sh tars it. A production process without it refuses
 * personal file writes rather than writing into the container's own layer,
 * where the bytes would vanish on the next roll.
 */
import { createReadStream, promises as fs, type ReadStream } from 'node:fs';
import path from 'node:path';
import { env, isProduction } from '@mantle/config';
import { filesRoot } from './paths';
import type { SpooledUpload } from './disk';

/** Thrown when this process has no durable spaces root (production without
 *  MANTLE_SPACES_ROOT: an older compose file). Routes answer 503. */
export class SpacesRootUnavailableError extends Error {
  constructor() {
    super('Personal file storage is not set up on this server yet.');
    this.name = 'SpacesRootUnavailableError';
  }
}

/** The spaces root. Development falls back to a sibling of the files root
 *  (`./data/spaces` next to `./data/files`), outside the files watcher. */
export function spacesRoot(): string {
  const configured = env('MANTLE_SPACES_ROOT')?.trim();
  if (configured) return path.resolve(configured);
  if (isProduction()) throw new SpacesRootUnavailableError();
  return path.resolve(filesRoot(), '..', 'spaces');
}

/** True when personal file bytes can be stored durably here. */
export function spacesRootAvailable(): boolean {
  try {
    spacesRoot();
    return true;
  } catch {
    return false;
  }
}

/** Ids come from our own database, but never trust them as path segments. */
function safeId(id: string, label: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(`space-disk: unsafe ${label}: ${JSON.stringify(id)}`);
  }
  return id.toLowerCase();
}

/** One space's directory. */
export function spaceDir(spaceId: string): string {
  return path.join(spacesRoot(), safeId(spaceId, 'space id'));
}

/** Where one personal file's bytes live. */
export function spaceFilePath(spaceId: string, nodeId: string): string {
  return path.join(spaceDir(spaceId), 'files', safeId(nodeId, 'node id'));
}

/** In-flight member uploads spool here, inside the spaces root, so adoption
 *  is a rename on one filesystem. */
export function spaceSpoolDir(): string {
  return path.join(spacesRoot(), '.upload-spool');
}

/** Move a spooled upload into its space. On any failure the spool is removed. */
export async function adoptSpooledIntoSpace(
  spaceId: string,
  nodeId: string,
  spooled: SpooledUpload,
): Promise<{ path: string; sha256: string; size: number }> {
  try {
    const dest = spaceFilePath(spaceId, nodeId);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.rename(spooled.tempPath, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fs.copyFile(spooled.tempPath, dest);
      await fs.unlink(spooled.tempPath);
    }
    return { path: dest, sha256: spooled.sha256, size: spooled.size };
  } catch (err) {
    await fs.unlink(spooled.tempPath).catch(() => {});
    throw err;
  }
}

/** Write bytes a caller already holds (tests, small generated files). */
export async function writeSpaceFile(
  spaceId: string,
  nodeId: string,
  bytes: Buffer,
): Promise<{ path: string; size: number }> {
  const dest = spaceFilePath(spaceId, nodeId);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
  return { path: dest, size: bytes.byteLength };
}

/** A read stream over one personal file, or null when the bytes are gone. */
export async function openSpaceFile(
  spaceId: string,
  nodeId: string,
): Promise<{ stream: ReadStream; size: number } | null> {
  const p = spaceFilePath(spaceId, nodeId);
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return null;
    return { stream: createReadStream(p), size: st.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** The whole file in memory (thumbnails; bounded by the member upload cap). */
export async function readSpaceFile(spaceId: string, nodeId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(spaceFilePath(spaceId, nodeId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Remove one personal file's bytes. Missing bytes are fine. */
export async function removeSpaceFile(spaceId: string, nodeId: string): Promise<void> {
  await fs.rm(spaceFilePath(spaceId, nodeId), { force: true });
}
