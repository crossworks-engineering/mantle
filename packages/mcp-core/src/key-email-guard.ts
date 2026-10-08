/**
 * An API key without the Search area does not reach email (access matrix
 * M4). The attachments of synced mail are file nodes in the attachments
 * folder under each mail, so for such a key the Files tools:
 *
 *  - lists (`file_list`, `folder_list`) drop the attachment rows and the
 *    attachments folders, and run as before otherwise;
 *  - every other Files tool is refused when a file id, folder id or folder
 *    path it names is, is inside, or holds a mail's attachments (a copy,
 *    move, read, rename, delete or upload there).
 *
 * What counts as an attachment is where the file sits, never its bytes
 * (packages/files/src/email-attachments.ts).
 */
import { emailAttachmentFolders, reachesEmailAttachment } from '@mantle/files';
import type { ToolCallGuard, ToolCallResult } from './build-server';
import { toolKeyArea } from './key-scope';

const ID_FIELDS = ['file_id', 'folder_id', 'id'] as const;
const PATH_FIELDS = ['parent_path', 'parent', 'path', 'dest_path', 'dest_parent_path'] as const;
const LIST_TOOLS: ReadonlySet<string> = new Set(['file_list', 'folder_list']);

export const KEY_EMAIL_REFUSAL =
  'this is an email attachment, or a folder of them, and this key reaches email only with the Search area.';

/** The rows of a list result, or null when it is not a JSON array. */
function rowsOf(result: ToolCallResult): Record<string, unknown>[] | null {
  const text = result.content?.[0]?.text;
  if (result.isError || typeof text !== 'string') return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
  } catch {
    return null;
  }
}

export function keyEmailGuard(ownerId: string): ToolCallGuard {
  return {
    before: async (slug, args) => {
      if (toolKeyArea(slug) !== 'files' || LIST_TOOLS.has(slug)) return null;
      for (const field of ID_FIELDS) {
        const v = args[field];
        if (typeof v === 'string' && (await reachesEmailAttachment(ownerId, { id: v.trim() }))) {
          return KEY_EMAIL_REFUSAL;
        }
      }
      for (const field of PATH_FIELDS) {
        const v = args[field];
        if (typeof v === 'string' && (await reachesEmailAttachment(ownerId, { path: v }))) {
          return KEY_EMAIL_REFUSAL;
        }
      }
      return null;
    },
    after: async (slug, _args, result) => {
      if (!LIST_TOOLS.has(slug)) return result;
      const rows = rowsOf(result);
      if (!rows) return result;
      // A file row names its folder (parentPath), a folder row its path.
      const key = slug === 'file_list' ? 'parentPath' : 'path';
      const paths = rows.map((r) => r[key]).filter((p): p is string => typeof p === 'string');
      const hidden = await emailAttachmentFolders(ownerId, paths);
      if (hidden.size === 0) return result;
      const kept = rows.filter((r) => !hidden.has(r[key] as string));
      return { ...result, content: [{ type: 'text', text: JSON.stringify(kept, null, 2) }] };
    },
  };
}
