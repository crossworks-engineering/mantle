/**
 * What a file write hands back to a team app (member-app-tools.ts rule 7).
 * It writes as its runner, wherever that user may write by hand, so the
 * file may be one the app itself cannot read; and what the app gets back
 * can land in its shared database, which every user of the app reads. So a
 * team app's write gets the file's place and kind only: never its summary
 * (read from its content), its title or its hash. Any other caller: the
 * whole row, as before.
 */
import { inAppRunWrite } from '@mantle/db';
import { type FileRow } from '@mantle/files';

export type AppFileOutput = Pick<
  FileRow,
  'id' | 'parentPath' | 'filename' | 'extension' | 'mimeType' | 'sizeBytes'
>;

export function fileWriteOutput(row: FileRow): FileRow | AppFileOutput {
  if (!inAppRunWrite()) return row;
  const { id, parentPath, filename, extension, mimeType, sizeBytes } = row;
  return { id, parentPath, filename, extension, mimeType, sizeBytes };
}
