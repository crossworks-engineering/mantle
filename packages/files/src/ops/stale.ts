/**
 * The files that need attention (docs/files.md, "Reindex and stale
 * indexes"): one page, newest first, in the caller's scope, of the files in
 * one state:
 *
 *  - `stale`: read by an older reader or pipeline than the box has now (the
 *    stamps of ../read-stamp.ts; a file with no stamp is never here);
 *  - `failed`: its content could not be read (extraction state `failed`);
 *  - `partial`: read in part (a scan's first pages).
 *
 * One query for the page and one for the total, both in the caller's scope
 * and on the SAME predicate, then the rows of the page by id: `total` and
 * the rows always agree. The stale cut finds its rows in the two partial
 * indexes of migration 0384 (no pass over every file's data): a reader's
 * part only for a reader whose version was raised, a pipeline's only for
 * the files it read at another version than the installed one, and not
 * where the pipeline is off in the file's home (no Reader run would follow
 * a reindex there). The cut is the SQL form of the one rule (staleOf, and
 * the stamps' own form: readByOf, pipelineReadStampOf); the failed and
 * partial cuts are the SQL form of extractionOf. read-stamp tests and the
 * route's db test hold the two forms together.
 *
 * Read only. Paging is by (updated_at, id), so a page never repeats or skips
 * a row that does not change meanwhile.
 */
import { and, eq, getTableColumns, isNull, sql, type SQL } from 'drizzle-orm';
import { db, itemHomeSql, nodes, READ_FAILURE_SKIPS, type Node } from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { emailAttachmentIds } from '../email-attachments';
import { keyWithoutSearch } from '../file-data';
import { READER_VERSIONS, type InstalledPipeline } from '../read-stamp';
import { fileRowFromNode, type FileRow } from './shared';

export type StaleListState = 'stale' | 'failed' | 'partial';
export const STALE_LIST_STATES: readonly StaleListState[] = ['stale', 'failed', 'partial'];
export const STALE_LIST_DEFAULT = 50;
export const STALE_LIST_MAX = 200;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** The stale cut: a reader's files below its version, a pipeline's files
 *  below the installed version (not where it is off). False when nothing
 *  can be stale. Each part names the predicate of its partial index (0384)
 *  in the text itself, so a generic plan still proves it; the keys and
 *  versions are parameters, the index's conditions. */
function staleCut(installed: readonly InstalledPipeline[]): SQL {
  const parts: SQL[] = [];
  for (const [reader, v] of Object.entries(READER_VERSIONS)) {
    // One range of the index each (an empty one for a reader at 1).
    parts.push(sql`("nodes"."type" = 'file' and "nodes"."data" ? 'read_by'
      and ("nodes"."data" -> 'read_by' ->> 'reader') = ${reader}
      and ("nodes"."data" -> 'read_by' -> 'v') < ${String(v)}::jsonb
      and jsonb_typeof("nodes"."data" -> 'read_by' -> 'v') = 'number')`);
  }
  for (const p of installed) {
    const m = SEMVER.exec(p.version);
    if (!m) continue;
    const v = sql`("nodes"."data" -> 'pipeline_read' ->> 'version')`;
    // A stamp in its form only (pipelineReadStampOf: id and version text).
    const form = sql`jsonb_typeof("nodes"."data" -> 'pipeline_read' -> 'id') = 'string'
      and jsonb_typeof("nodes"."data" -> 'pipeline_read' -> 'version') = 'string'`;
    // Not where it is off: a file homed there gets no Reader run.
    const on = p.offIn?.length
      ? sql`and not coalesce(${itemHomeSql()} = any (${`{${p.offIn.join(',')}}`}::uuid[]), false)`
      : sql``;
    parts.push(sql`("nodes"."type" = 'file' and "nodes"."data" ? 'pipeline_read'
      and ("nodes"."data" -> 'pipeline_read' ->> 'id') = ${p.id}
      and (${v} < ${p.version} or ${v} > ${p.version})
      and ${form} ${on}
      and case when ${v} ~ '^[0-9]+[.][0-9]+[.][0-9]+$'
               then string_to_array(${v}, '.')::numeric[]
                    < array[${m[1]}, ${m[2]}, ${m[3]}]::numeric[]
               else true end)`);
  }
  return parts.length ? sql`(${sql.join(parts, sql` or `)})` : sql`false`;
}

/** The exact SQL of the extraction rule (extractionOf) for `failed` and
 *  `partial`; the rows are checked again with the rule itself. */
function readCut(state: 'failed' | 'partial'): SQL {
  const notNameOnly = sql`coalesce(${nodes.data}->>'indexing_applied', '') <> 'metadata'`;
  const reasonIsText = sql`jsonb_typeof(${nodes.data}->'extract_skipped'->'reason') = 'string'`;
  if (state === 'failed') {
    const failedReason = sql`${nodes.data}->'extract_skipped'->>'reason' in (${sql.join(
      READ_FAILURE_SKIPS.map((r) => sql`${r}`),
      sql`, `,
    )})`;
    return sql`(${notNameOnly} and ((${reasonIsText} and ${failedReason})
      or (not coalesce(${reasonIsText}, false) and ${nodes.data} ? 'extract_parked')))`;
  }
  const ocr = (k: string) => sql`${nodes.data}->'ocr'->${k}`;
  return sql`(${notNameOnly} and not coalesce(${reasonIsText}, false)
    and not (${nodes.data} ? 'extract_parked') and ${nodes.data} ? 'extract_completed_at'
    and case when jsonb_typeof(${ocr('pages_read')}) = 'number'
                  and jsonb_typeof(${ocr('pages_total')}) = 'number'
             then (${ocr('pages_read')})::text::numeric < (${ocr('pages_total')})::text::numeric
             else false end)`;
}

/** The cursor of the row after which the next page starts. */
function cursorOf(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`, 'utf8').toString('base64url');
}

/** The ISO form of the time a cursor carries (to_json of a timestamptz):
 *  date, time, up to 6 digits of a second, and its zone. */
const CURSOR_TS =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** The (updated_at, id) a cursor names, or null when it is not one: the
 *  time only in its ISO form and a real day, so a crafted cursor is a 400,
 *  never a database error. */
export function parseStaleCursor(cursor: string): { ts: string; id: string } | null {
  if (cursor.length > 200) return null;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const at = text.lastIndexOf('|');
  if (at < 0) return null;
  const ts = text.slice(0, at);
  const id = text.slice(at + 1);
  const m = CURSOR_TS.exec(ts);
  if (!m || !UUID_RE.test(id)) return null;
  // A real day of that month (no 31 April, no 29 February out of a leap year).
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (day.getUTCDate() !== Number(m[3])) return null;
  return { ts, id };
}

/** A file row with no vector, and its data without the long text the
 *  listing never shows. */
function listSelect() {
  const { embedding: _embedding, ...columns } = getTableColumns(nodes);
  return {
    ...columns,
    data: sql<unknown>`${nodes.data} - 'text' - 'agent_text' - 'entities'`.as('data'),
  };
}

/**
 * One page of the files in `state` the caller reads, newest first.
 * `installed`: the box's pipelines that run (BoxPipelines.acted), for the
 * stale cut. `cursor` is a `next` of a page before (parseStaleCursor). The
 * answer's rows are file rows (fileRowFromNode); the caller adds the
 * status. An API key without the Search area does not get email attachment
 * rows (as listFilesByExtraction); `total` may count them.
 */
export async function listFilesNeedingAttention(args: {
  ownerId: string;
  state: StaleListState;
  installed: readonly InstalledPipeline[];
  cursor?: { ts: string; id: string } | null;
  limit?: number;
}): Promise<{ files: FileRow[]; next: string | null; total: number }> {
  const limit = Math.min(STALE_LIST_MAX, Math.max(1, args.limit ?? STALE_LIST_DEFAULT));
  const cut = args.state === 'stale' ? staleCut(args.installed) : readCut(args.state);
  const where = and(
    eq(nodes.ownerId, args.ownerId),
    eq(nodes.type, 'file'),
    isNull(nodes.supersededBy),
    cut,
  );
  const after = args.cursor
    ? sql`(${nodes.updatedAt}, ${nodes.id}) < (${args.cursor.ts}::timestamptz, ${args.cursor.id}::uuid)`
    : undefined;
  const [page, counted] = await Promise.all([
    db
      .select({ id: nodes.id, ts: sql<string>`to_json(${nodes.updatedAt}) #>> '{}'` })
      .from(nodes)
      .where(and(where, after))
      .orderBy(sql`${nodes.updatedAt} desc`, sql`${nodes.id} desc`)
      .limit(limit + 1),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(nodes)
      .where(where),
  ]);
  const more = page.length > limit;
  const ids = page.slice(0, limit);
  let files: FileRow[] = [];
  if (ids.length) {
    const rows = await db
      .select(listSelect())
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, args.ownerId),
          sql`${nodes.id} = any (${`{${ids.map((r) => r.id).join(',')}}`}::uuid[])`,
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, fileRowFromNode(r as unknown as Node)]));
    // The rows of the page as found: the same predicate as `total`.
    files = ids.map((r) => byId.get(r.id)).filter((f): f is FileRow => f !== undefined);
  }
  if (keyWithoutSearch() && files.length > 0) {
    const hidden = await emailAttachmentIds(
      args.ownerId,
      files.map((f) => f.id),
    );
    files = files.filter((f) => !hidden.has(f.id));
  }
  const last = ids[ids.length - 1];
  return {
    files,
    next: more && last ? cursorOf(last.ts, last.id) : null,
    total: counted[0]?.n ?? 0,
  };
}
