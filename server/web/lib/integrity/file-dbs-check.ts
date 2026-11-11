/**
 * The file databases, on the corpus audit's list: the SQL checks there cannot
 * read a disk, so this is pushed after their transaction (runCorpusAudit). Its
 * own SQL still runs in a READ ONLY transaction, and nothing here writes.
 *
 *  - table-type files with no name, by the rebuild's own row filter, leaving out
 *    private files and, in this count only, XML (most XML is no plan);
 *  - of those, a row with no valid sha256 has its own line: nothing can name a
 *    database for it, so the rebuild cannot clear it;
 *  - a file's word, by word, so a mark from two parser crashes is seen;
 *  - names with no live row, with their bytes. A changed drive file gets a new
 *    node, and its old node goes in a process with no files mount, so these
 *    collect. A person removes them with `dwg-reindex --orphans --apply`. Nothing
 *    removes them by itself, as a sweep on a wrong database could take good data;
 *  - live apps that hold any tool that reaches a Table: at 0 a box may take the
 *    line (an undelete is the gate's, so only live apps count);
 *  - whether the line is on, at count 0, with its value in the label.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { apps, nodes, readOnlyTransaction, tools } from '@mantle/db';
import { env, feature } from '@mantle/config';
import {
  fileDataExt,
  fileDataListKeys,
  fileSha256Of,
  flaggedFolders,
  FILE_DB_NONE_WORDS,
  isFileSha256,
  listFileDbFolder,
  privateByFlags,
  readFileDbNone,
  tableFileFilter,
  type FileDbNoneWord,
} from '@mantle/files';
import { isUuid } from '@mantle/std';
import { appListReachesTables } from '@mantle/tools';
import type { AuditCheck, AuditSample } from '@mantle/client-types/types/integrity';

const sha16Of = (row: { data: unknown }) => {
  const sha = fileSha256Of(row);
  return typeof sha === 'string' ? sha.slice(0, 16) : '';
};

function check(
  key: string,
  label: string,
  severity: AuditCheck['severity'],
  note: string,
  count: number,
  samples: AuditSample[] = [],
): AuditCheck {
  return {
    key,
    label,
    severity,
    note,
    count,
    capped: false,
    ok: count === 0,
    samples: samples.slice(0, 5),
    oldestAt: null,
    newestAt: null,
  };
}

const NONE_NOTES: Record<FileDbNoneWord, string> = {
  'too-large': 'past a size or row limit, so file_sql says so and it has no rows to read.',
  'no-rows': 'read, with no rows in it.',
  unreadable:
    'the parser refused it for good, or twice on the same bytes. `dwg-reindex --again --apply` asks again.',
};

export async function fileDatabaseChecks(ownerId: string): Promise<AuditCheck[]> {
  // The folder before the rows, so a row is never older than a name it is
  // judged against.
  const folder = await listFileDbFolder();
  const nameIds = [...new Set(folder.names.map((n) => n.fileId))].filter((id) => isUuid(id));
  const { rows, flagged, liveIds, appRows, toolRows } = await readOnlyTransaction(async (tx) => ({
    rows: await tx
      .select({ id: nodes.id, path: nodes.path, title: nodes.title, data: fileDataListKeys() })
      .from(nodes)
      .where(and(tableFileFilter({ xml: true }), eq(nodes.ownerId, ownerId))),
    flagged: await flaggedFolders(tx, ownerId),
    liveIds: nameIds.length
      ? await tx
          .select({ id: nodes.id })
          .from(nodes)
          .where(and(eq(nodes.type, 'file'), inArray(nodes.id, nameIds)))
      : [],
    appRows: await tx
      .select({ id: apps.nodeId, slugs: sql<unknown>`${apps.manifest}->'toolSlugs'` })
      .from(apps)
      .innerJoin(nodes, eq(nodes.id, apps.nodeId))
      .where(eq(nodes.ownerId, ownerId)),
    toolRows: await tx
      .select()
      .from(tools)
      .where(and(eq(tools.ownerId, ownerId), eq(tools.enabled, true))),
  }));

  const named = new Set(folder.names.map((n) => `${n.fileId}.${n.sha16}`));
  const hidden = privateByFlags(rows, flagged);
  const missing: AuditSample[] = [];
  const noSha: AuditSample[] = [];
  const words: Record<FileDbNoneWord, AuditSample[]> = {
    'too-large': [],
    'no-rows': [],
    unreadable: [],
  };
  for (const row of rows) {
    const ext = fileDataExt(row);
    if (!named.has(`${row.id}.${sha16Of(row)}`)) {
      if (ext !== 'xml' && !hidden.has(row.id)) {
        const list = isFileSha256(fileSha256Of(row)) ? missing : noSha;
        list.push({ id: row.id, kind: 'file', detail: ext });
      }
      continue;
    }
    const word = await readFileDbNone(row.id, fileSha256Of(row));
    if (word) words[word].push({ id: row.id, kind: 'file', detail: ext });
  }

  const live = new Set(liveIds.map((r) => r.id));
  const stranded = folder.names.filter((n) => isUuid(n.fileId) && !live.has(n.fileId));
  const strandedBytes = stranded.reduce((sum, n) => sum + n.bytes, 0);

  const holding: AuditSample[] = [];
  for (const app of appRows) {
    const slugs = Array.isArray(app.slugs) ? app.slugs.map(String) : [];
    if (await appListReachesTables(ownerId, slugs, toolRows)) {
      holding.push({ id: app.id, kind: 'app', detail: '' });
    }
  }

  const line = env('MANTLE_NO_AUTO_TABLES')?.trim() ?? '';
  return [
    check(
      'file_db_missing',
      'Table-type files with no database and no word',
      'medium',
      'No rows for file_sql, and an old Table is all a reader has. The rebuild heals them: `dwg-reindex --apply`. Private files, XML and PDF are left out.',
      missing.length,
      missing,
    ),
    check(
      'file_db_no_sha',
      'Table-type files with no checksum on the row',
      'low',
      'Nothing can name a database for these, so the rebuild skips them (no-sha). Uploading the file again gives it one.',
      noSha.length,
      noSha,
    ),
    ...FILE_DB_NONE_WORDS.map((word) =>
      check(
        `file_db_word_${word.replace('-', '_')}`,
        `Table-type files with the word ${word}`,
        'low',
        `This file's current bytes are marked ${word}: ${NONE_NOTES[word]}`,
        words[word].length,
        words[word],
      ),
    ),
    check(
      'file_db_no_live_row',
      `File database names with no live row (${strandedBytes} bytes)`,
      'low',
      'Unreachable, as rights are the row. A changed drive file leaves one for each edit. `dwg-reindex --orphans` lists them, and with --apply removes them. Nothing removes them by itself.',
      stranded.length,
    ),
    check(
      'apps_holding_table_tools',
      'Live apps that hold a tool that reaches a Table',
      'medium',
      'A box takes MANTLE_NO_AUTO_TABLES only at 0: with the line, these calls are refused.',
      holding.length,
      holding,
    ),
    check(
      'no_auto_tables_line',
      `MANTLE_NO_AUTO_TABLES is ${feature('noAutoTables') ? 'on' : 'off'} (value: ${line || 'not set'})`,
      'low',
      'On: a new file gets its database and no Table, and no app reaches a Table tool. This line only reports it.',
      0,
    ),
  ];
}
