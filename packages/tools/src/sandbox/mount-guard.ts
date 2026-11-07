/**
 * Sandbox inbox mounts and per-login files (docs/sandboxes.md, "The inbox
 * mount"). A mount is the folder's whole directory on disk, every file in
 * it whoever may read it, and it is live: a file moved or copied into the
 * folder later shows in it, and a sandbox made before the brain checked may
 * mount anything. So the folder is checked at the create and again before
 * every call that runs in the sandbox (exec, ls, autostart, the MCP calls,
 * publish): one daemon list (which folder each container mounts) and one
 * indexed lookup, a call refused while the folder holds another login's
 * private file (a file with login_id set: one sent in a login's chat or
 * over its Telegram).
 */
import { and, eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { db, nodes } from '@mantle/db';
import { filesRoot, ltreeForDiskPath } from '@mantle/files';
import { areaSystem } from '../admin-gate';
import { MOUNT_PRIVATE_FILES_ERROR, sandboxCaller, sandboxd } from './common';

/**
 * Whether a mount of the folder at `folderPath` would show the sandbox a file
 * private to another login than `login`: the mount is the folder's whole
 * directory on disk, whoever may read each file. So it is refused over any
 * folder holding a file whose node has login_id set to another login. Read
 * on the system pool (areaSystem): the caller's scope would not see the
 * rows it asks about.
 */
export async function mountShowsOtherLogins(
  ownerId: string,
  folderPath: string,
  login: string,
): Promise<boolean> {
  const [row] = await areaSystem('settings', () =>
    db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          sql`${nodes.path} <@ ${folderPath}::ltree`,
          sql`${nodes.loginId} is not null and ${nodes.loginId} <> ${login}::uuid`,
        ),
      )
      .limit(1),
  );
  return Boolean(row);
}

/** The Files folder (an ltree path) at `sub`, a path relative to the Files
 *  root as sandboxd reports it ('' the root), or null when it is not one. */
function folderPathOf(sub: string): string | null {
  if (sub === '') return 'files';
  if (sub.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return ltreeForDiskPath(path.join(filesRoot(), sub, '.mount'))?.parentPath ?? null;
}

/**
 * Why sandbox `sandboxId` may not run a call now, or null: it mounts a Files
 * folder that holds another login's private file (mountShowsOtherLogins),
 * or one sandboxd cannot place under the Files root
 * (refused rather than guessed). A sandbox the daemon does not list mounts
 * nothing this check knows of (the call itself then answers). A daemon that
 * cannot answer refuses the call: the mount is unknown.
 */
export async function liveMountRefusal(ownerId: string, sandboxId: string): Promise<string | null> {
  const live = await sandboxd('GET', '/sandboxes');
  if (!live.ok) return live.error;
  const rows = Array.isArray(live.data.sandboxes)
    ? (live.data.sandboxes as Array<{ id?: unknown; inboxMounted?: unknown; inbox?: unknown }>)
    : [];
  const mine = rows.find((r) => r.id === sandboxId);
  if (!mine || mine.inboxMounted !== true) return null;
  const folder = typeof mine.inbox === 'string' ? folderPathOf(mine.inbox) : null;
  if (!folder) return MOUNT_PRIVATE_FILES_ERROR;
  const login = sandboxCaller() ?? ownerId;
  return (await mountShowsOtherLogins(ownerId, folder, login)) ? MOUNT_PRIVATE_FILES_ERROR : null;
}
