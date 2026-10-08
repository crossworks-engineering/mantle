/**
 * An API key without the Search area does not reach email (access matrix
 * M4). The attachments of synced mail are file nodes, so the Files tools
 * would list, read and copy them: before a Files tool runs for such a key,
 * any file id, folder id or folder path it names that is, or holds, an
 * email attachment refuses the call.
 */
import { reachesEmailAttachment } from '@mantle/files';
import type { ToolCallGuard } from './build-server';
import { toolKeyArea } from './key-scope';

const ID_FIELDS = ['file_id', 'folder_id', 'id'] as const;
const PATH_FIELDS = ['parent_path', 'parent', 'path'] as const;

export const KEY_EMAIL_REFUSAL =
  'this is an email attachment, or a folder of them, and this key reaches email only with the Search area.';

export function keyEmailGuard(ownerId: string): ToolCallGuard {
  return async (slug, args) => {
    if (toolKeyArea(slug) !== 'files') return null;
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
  };
}
