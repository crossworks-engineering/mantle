/**
 * An API key without the Search area does not reach email (access matrix
 * M4). The attachments of synced mail are file nodes in the attachments
 * folder under each mail, and image files, Tables, pages and notes are made
 * from them (the extractor, page_from_file, note_from_file: T4), so for such
 * a key the Files, Tables, Pages and Notes tools:
 *
 *  - lists (`file_list`, `folder_list`, `table_list`, `page_list`,
 *    `note_list`) drop the attachment
 *    rows, the items made from one and the attachments folders, and run as
 *    before otherwise;
 *  - every other tool of those areas is refused when an item id, folder id
 *    or folder path it names is, is inside, or holds a mail's attachments,
 *    or is an item made from one (a copy, move, read, rename, delete, a
 *    table made from an attachment, or an upload there).
 *
 * What counts as an attachment is where the file sits, never its bytes
 * (packages/files/src/email-attachments.ts).
 */
import { emailAttachmentFolders, emailAttachmentIds, reachesEmailAttachment } from '@mantle/files';
import type { ToolCallGuard, ToolCallResult } from './build-server';
import { toolKeyArea } from './key-scope';

const ID_FIELDS = [
  'file_id',
  'folder_id',
  'id',
  'table_id',
  'node_id',
  'page_id',
  'note_id',
] as const;
const ID_LIST_FIELDS = ['file_ids', 'table_ids'] as const;
const PATH_FIELDS = ['parent_path', 'parent', 'path', 'dest_path', 'dest_parent_path'] as const;
const LIST_TOOLS: ReadonlySet<string> = new Set([
  'file_list',
  'folder_list',
  'table_list',
  'page_list',
  'note_list',
]);
const GUARDED_AREAS: ReadonlySet<string> = new Set(['files', 'tables', 'pages', 'notes']);

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
      const area = toolKeyArea(slug);
      if (!area || !GUARDED_AREAS.has(area) || LIST_TOOLS.has(slug)) return null;
      const ids: string[] = [];
      for (const field of ID_FIELDS) {
        const v = args[field];
        if (typeof v === 'string') ids.push(v.trim());
      }
      for (const field of ID_LIST_FIELDS) {
        const v = args[field];
        if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') ids.push(x.trim());
      }
      for (const id of ids) {
        if (await reachesEmailAttachment(ownerId, { id })) return KEY_EMAIL_REFUSAL;
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
      // A folder row is hidden by its path (an attachments folder). A file
      // row by its folder (parentPath), and a file or table row by its id
      // too (an item made from an attachment sits in an ordinary folder).
      const pathKey = slug === 'file_list' ? 'parentPath' : slug === 'folder_list' ? 'path' : null;
      const paths = pathKey
        ? rows.map((r) => r[pathKey]).filter((p): p is string => typeof p === 'string')
        : [];
      const hiddenFolders = await emailAttachmentFolders(ownerId, paths);
      const hiddenIds =
        slug === 'folder_list'
          ? new Set<string>()
          : await emailAttachmentIds(
              ownerId,
              rows.map((r) => r.id).filter((id): id is string => typeof id === 'string'),
            );
      if (hiddenFolders.size === 0 && hiddenIds.size === 0) return result;
      const kept = rows.filter(
        (r) =>
          !(pathKey && hiddenFolders.has(r[pathKey] as string)) &&
          !(typeof r.id === 'string' && hiddenIds.has(r.id)),
      );
      return { ...result, content: [{ type: 'text', text: JSON.stringify(kept, null, 2) }] };
    },
  };
}
