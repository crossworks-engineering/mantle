/**
 * Destination resolution for `sandbox_import` — the one place a caller-supplied
 * string becomes a HOST filesystem path.
 *
 * sandboxd writes imports straight into the sandbox's bind-mounted host
 * directory rather than through the container, which is what keeps binaries
 * byte-exact. That speed comes with the obvious hazard: `../../etc/cron.d/x`
 * would escape the sandbox's dir and land on the host, and sandboxd runs as
 * root with the docker socket. So containment is checked twice, in kind rather
 * than in degree: the RELATIVE form is rejected outright for a leading slash or
 * any `..` segment, and the RESOLVED absolute path is then required to sit
 * under the root. The second check is what catches anything the first misses
 * (symlinked segments, encodings, a platform quirk in path.join).
 *
 * Extracted from main.ts purely so it can be tested without booting the daemon.
 */
import path from 'node:path';

export class ImportPathError extends Error {}

/**
 * Resolve `rel` (a path the caller wants under /files) against the sandbox's
 * host files dir. Throws `ImportPathError` with a message meant for the model
 * when the path is missing or tries to leave the directory.
 */
export function resolveImportPath(
  filesRoot: string,
  relRaw: string,
): { rel: string; dest: string } {
  // `/files/x` and `files/x` and `x` all mean the same thing to a caller
  // looking at the sandbox; normalise before judging.
  const rel = relRaw.replace(/^\/?files\/?/, '').trim();
  if (!rel) throw new ImportPathError('path is required, e.g. "data/register.accdb"');
  // Checked AFTER the strip, so `/files/x` (how the caller sees it inside the
  // container) is fine while `/etc/x` is not.
  if (rel.startsWith('/') || rel.split('/').some((seg) => seg === '..')) {
    throw new ImportPathError('path must stay under /files (no leading / and no ..)');
  }
  const root = path.resolve(filesRoot);
  const dest = path.resolve(path.join(root, rel));
  if (dest !== root && !dest.startsWith(root + path.sep)) {
    throw new ImportPathError('path must stay under /files');
  }
  if (dest === root) throw new ImportPathError('path must name a file, not /files itself');
  return { rel, dest };
}

/** The read-only Files folder a container shows at /mnt/inbox. */
export const INBOX_MOUNT_DEST = '/mnt/inbox';

/**
 * Which Files folder a container mounts at /mnt/inbox, from its mounts (the
 * docker summary's `Mounts`): `{ mounted: false }` for none; else the folder
 * relative to the Files root (`inboxRoot`, host-absolute), `''` for the root
 * itself, or `sub: null` when the mount is not under that root (or no root is
 * configured), which the caller must refuse rather than guess. The brain
 * checks the folder before every call that runs in the sandbox, since the
 * mount is live (a file put there after the create shows in it).
 */
export function inboxMountOf(
  mounts: ReadonlyArray<{ Destination?: string; Source?: string }> | undefined,
  inboxRoot: string,
): { mounted: false } | { mounted: true; sub: string | null } {
  const m = (mounts ?? []).find((x) => x.Destination === INBOX_MOUNT_DEST);
  if (!m) return { mounted: false };
  if (!inboxRoot || !m.Source) return { mounted: true, sub: null };
  const root = path.resolve(inboxRoot);
  const src = path.resolve(m.Source);
  if (src === root) return { mounted: true, sub: '' };
  if (!src.startsWith(root + path.sep)) return { mounted: true, sub: null };
  return { mounted: true, sub: path.relative(root, src).split(path.sep).join('/') };
}
