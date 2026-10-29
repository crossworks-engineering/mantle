/**
 * The queue-time folder rule of a create: before a call is queued for
 * approval, a create whose target folder is named by its path is asked of the
 * queuing scope. The one gate's pre-run check (gate-prerun.ts itemPrecheck)
 * is its only caller.
 *
 * Tools have no item pre-check (docs/actors.md, "11. Tools"): the
 * database's checks, or the library's own item check before any side effect
 * (assertItemRight, @mantle/db item-rights.ts), refuse an item write. A new
 * tool relies on those and declares no item list (the arch pin
 * itemPrecheckTools is 0).
 */
import { foldersReadOf, scopeHoldsAdmin } from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import { clampFilesFolderPath } from '@mantle/files';

/** The refusal, before a call is queued for approval, of a reference (a
 *  Recall map by its slug, a create's target folder by its path) the queuing
 *  scope does not read: it says what to name instead, never that the thing
 *  exists or where to look for it. */
export function refNotInScopeError(what: string, lookup: string): string {
  return `${what} is not one in your workspaces, so this call is not queued for approval: name one of yours (${lookup} lists them).`;
}

/** The ltree paths of the folders on `path` below its kind's root, the
 *  shortest first: files.a.b gives files.a and files.a.b. */
function folderPrefixes(path: string): string[] {
  const parts = path.split('.');
  const out: string[] = [];
  for (let n = 2; n <= parts.length; n += 1) out.push(parts.slice(0, n).join('.'));
  return out;
}

/**
 * Before a call is queued for approval:
 * a create whose target folder is named by its path (the policy's
 * `createsIn`) is asked of the queuing scope, in the item check's words.
 * The approved call runs in the approver's scope, which may read (and
 * create in) a folder this scope does not.
 *
 *  - A create that makes the missing folders of its path itself
 *    (`makesFolders`: file_create) is asked of the
 *    deepest folder of the path, cut to the depth its handler cuts it to
 *    (clampFilesFolderPath), that the scope reads: one there, the create
 *    queues (a new subfolder of a folder of the scope's lands inside it,
 *    and dispatch asks the create again). None at all (only the kind's
 *    root, or folders it does not read), it is refused.
 *  - Any other create needs the folder itself, read by the scope.
 *
 * A path that is only a kind's root (`files`: one label, structure, not
 * content, read whatever the scope holds as upsertFile reads it) and a
 * scope that holds the Admin workspace (it queues for an approver of the
 * same workspace) are not asked. Outside a workspace scope nothing is
 * checked. Asked in the scope only (foldersReadOf): a folder it does not
 * read is never told apart from one that does not exist.
 */
export async function createFolderRefusal(
  param: string | undefined,
  input: Record<string, unknown>,
  ownerId: string,
  makesFolders = false,
): Promise<string | null> {
  if (!param) return null;
  const raw = typeof input[param] === 'string' ? input[param].trim() : '';
  if (!raw || !raw.includes('.')) return null;
  if (!currentWorkspaceScope()) return null;
  if (await scopeHoldsAdmin()) return null;
  const lookup = 'folder_list / tree_list';
  if (makesFolders && raw.startsWith('files.')) {
    const path = clampFilesFolderPath(raw);
    const read = await foldersReadOf(ownerId, folderPrefixes(path));
    if (read.size > 0) return null;
    return `No folder on the path ${path} is one in your workspaces, so this call is not queued for approval: put it in a folder of yours (${lookup} lists them).`;
  }
  const read = await foldersReadOf(ownerId, [raw]);
  return read.has(raw) ? null : refNotInScopeError(`Folder ${raw}`, lookup);
}
