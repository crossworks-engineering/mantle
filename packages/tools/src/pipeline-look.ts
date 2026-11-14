/**
 * The look at one file's database, as the list's counts and the re-read of
 * the older files both read it (docs/pipelines.md): its extension, its
 * stamp and its `pipelines_after`, from its `_meta`. No tab is read. What a
 * pipeline makes of it is pipelineReadOf (@mantle/files, stamp.ts), the one
 * place that decides "older".
 */
import {
  fileDataExt,
  fileDbSqlitePath,
  fileSha256Of,
  type FileDataRow,
  type FileDbSeen,
} from '@mantle/files';
import { readFileDbAfter, readFileDbStamp } from '@mantle/content/file-database';

/** The most file ids one call looks at: the list's look, and one call of
 *  the re-read. Past it the counts are partial, and the re-read gives
 *  `next`. */
export const PIPELINE_SCAN_MAX = 5000;

/** What a look sees of one file, or null when it has no database at its
 *  own bytes (a name of older bytes only). */
export async function seenOf(row: FileDataRow): Promise<FileDbSeen | null> {
  const sha = fileSha256Of(row);
  if (!(await fileDbSqlitePath(row.id, sha))) return null;
  const stamp = await readFileDbStamp(row.id, sha);
  const after = stamp
    ? stamp.pipelines_after
    : (await readFileDbAfter(row.id, sha))?.pipelines_after;
  return { ext: fileDataExt(row), stamp, after };
}
