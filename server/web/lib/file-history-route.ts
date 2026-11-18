/**
 * The file history routes' one first read (app/api/files/files/[id]/history):
 * the file in the caller's scope, the 404 of none for one it does not read
 * (as for an id no row has), and for an API key without the Search area an
 * email attachment is none too (access matrix M4, as GET
 * /api/files/files/:id answers it). Before anything else is read or written.
 */
import { emailAttachmentIds, fileById, type FileRow } from '@mantle/files';
import { callerMayReadEmail } from '@/lib/api-v1';

export async function historyFileOrNull(ownerId: string, fileId: string): Promise<FileRow | null> {
  if (!callerMayReadEmail() && (await emailAttachmentIds(ownerId, [fileId])).has(fileId)) {
    return null;
  }
  return fileById({ ownerId, fileId });
}
