/**
 * The note `file_get` and `file_read` give a file with a file database: its
 * tabs and one line, "read its rows with file_sql". An agent that reads a
 * file finds its rows here, and does not build a vision reader for what the
 * database already holds (the words, tags and line numbers of a drawing).
 *
 * A picture cut from a file (`data.sourceFileId`: a DWG's model space, a
 * PDF's figure) has no database of its own: the note names its source's.
 *
 * The rights are file_sql's own two checks (the row in the caller's scope,
 * then fileDataRefusal), so the note shows only where file_sql answers. A
 * note that cannot be read is left out: it never breaks the read.
 */
import {
  fileDataRefusal,
  fileDataRow,
  fileDbSqlitePath,
  fileSha256Of,
  type FileDataRow,
} from '@mantle/files';
import { boxPipelines } from '@mantle/content/pipeline-registry';
import { withTabScanner } from '@mantle/tabledb';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';

/** The most tab names one note lists. */
const NOTE_TABS_MAX = 30;

export type FileDbNote = {
  /** The file whose database it is: set only for a picture's source. */
  file_id?: string;
  tabs: string[];
  /** Tabs past the listed ones. */
  more_tabs?: number;
  hint: string;
};

const HINT = 'Read its rows with file_sql (no model, no cost).';
const SOURCE_HINT =
  'This picture was cut from that file: read its rows with file_sql (no model, no cost), not this picture.';

/** The tab names of a row's database, when file_sql would read it: read
 *  in this process (fixed statements, read only), not through the shared
 *  SQL reader pool, so a busy pool never holds a file_get. */
async function tabsOf(
  ownerId: string,
  row: FileDataRow,
  dbExts: ReadonlySet<string>,
): Promise<{ tabs: string[]; more: number } | null> {
  if (await fileDataRefusal(ownerId, row, dbExts)) return null;
  const abs = await fileDbSqlitePath(row.id, fileSha256Of(row));
  if (!abs) return null;
  const all = withTabScanner(abs, (scan) => scan.names());
  return { tabs: all.slice(0, NOTE_TABS_MAX), more: Math.max(0, all.length - NOTE_TABS_MAX) };
}

/** The note for one file, or undefined when it has no database to read. */
export async function fileDbNote(ownerId: string, fileId: string): Promise<FileDbNote | undefined> {
  try {
    const row = await fileDataRow(ownerId, fileId);
    if (!row) return undefined;
    const { dbExts } = await boxPipelines(ownerId);
    const own = await tabsOf(ownerId, row, dbExts);
    if (own) return noteOf(own, HINT);
    const src = (row.data as Record<string, unknown> | null)?.sourceFileId;
    if (typeof src !== 'string' || src === row.id) return undefined;
    const srcRow = await fileDataRow(ownerId, src);
    const theirs = srcRow ? await tabsOf(ownerId, srcRow, dbExts) : null;
    return theirs ? { file_id: src, ...noteOf(theirs, SOURCE_HINT) } : undefined;
  } catch (err) {
    log('tools').warn(`file database note: not read: ${errorMessage(err)}`);
    return undefined;
  }
}

function noteOf(t: { tabs: string[]; more: number }, hint: string): FileDbNote {
  return { tabs: t.tabs, ...(t.more > 0 ? { more_tabs: t.more } : {}), hint };
}
