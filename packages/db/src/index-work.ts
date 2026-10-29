/**
 * The work stamp: `data.index_work`,
 * set, read and dropped here and nowhere else, with the one meaning of "the
 * item has a summary" its reader and its writers share.
 *
 * markContentChanged (content-changed.ts) is the only writer that SETS the
 * stamp: 'embed' (a new title, a table's cell commit) or 'extract' (a content
 * change). The extractor reads it (embedWork, server/api/src/agent/extract/
 * gates.ts) and drops it when the work is done: the summary write, the
 * re-embed, a terminal skip, the local index, the metadata-only index. All
 * of them ask this file what "no summary" means: an empty summary
 * (`summary: ''`, a model reply that was not JSON) must mean the same to the
 * reader and to the local path's guard, or the vector is never written and
 * the stamp never dropped.
 *
 * An 'embed' stamp on a row that HAD a vector before the reset also carries
 * `index_work_had_vector: true`: the item was indexed before, so with no
 * summary it re-embeds locally and never runs a first pass (an item with no
 * completion marker and an empty summary).
 *
 * Neither key is derived (edit-check.ts): the user's own write sets them,
 * through markContentChanged only (edit-check.test.ts pins it).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { IndexWork } from '@mantle/client-types/kinds';
import { nodes } from './schema/nodes';

/** The key of nodes.data a reset stamps with its work. */
export const INDEX_WORK_KEY = 'index_work';

/** Set with an 'embed' stamp when the row had a vector before the reset. */
export const INDEX_WORK_HAD_VECTOR_KEY = 'index_work_had_vector';

/** Both stamp keys, as dropped together. */
export const INDEX_WORK_KEYS = [INDEX_WORK_KEY, INDEX_WORK_HAD_VECTOR_KEY] as const;

const STAMP_KEYS = sql.raw(`array[${INDEX_WORK_KEYS.map((k) => `'${k}'`).join(', ')}]::text[]`);

/** ASCII whitespace, the same set in the JS test and the SQL one (btrim). */
const BLANK = /[ \t\n\r\f\v]/g;
const BLANK_SQL = sql.raw(`E' \\t\\n\\r\\f' || chr(11)`);

type Data = Record<string, unknown> | null | undefined;
type DataExpr = SQL | typeof nodes.data;

/**
 * Whether `data` holds a summary: a string with something other than
 * whitespace in it. An empty summary is no summary, for the gate, the
 * local path's guard and a table's commit alike (hasSummarySql is the same
 * test in SQL).
 */
export function hasSummary(data: unknown): boolean {
  const summary = (data as Data)?.summary;
  return typeof summary === 'string' && summary.replace(BLANK, '') !== '';
}

/** hasSummary in SQL, over a nodes.data expression. Never null. */
export function hasSummarySql(data: DataExpr = nodes.data): SQL {
  return sql`coalesce(jsonb_typeof(${data}->'summary') = 'string'
    and btrim(${data}->>'summary', ${BLANK_SQL}) <> '', false)`;
}

/** The work a reset stamped on `data`, or null. */
export function readIndexWork(data: unknown): IndexWork | null {
  return parseIndexWork((data as Data)?.[INDEX_WORK_KEY]);
}

/** A stamp read as text (indexWorkSql), or null. */
export function parseIndexWork(work: unknown): IndexWork | null {
  return work === 'embed' || work === 'extract' ? work : null;
}

/**
 * The stamp of `data` in SQL, as text (null with none). The extractor reads
 * it in the same select as the row's xmin, so the stamp its xmin-guarded
 * write drops is the one on the row it writes.
 */
export function indexWorkSql(data: DataExpr = nodes.data): SQL {
  return sql`${data}->>${INDEX_WORK_KEY}::text`;
}

/** Whether an 'embed' stamp on `data` was set on a row that had a vector. */
export function stampHadVector(data: unknown): boolean {
  return readIndexWork(data) === 'embed' && (data as Data)?.[INDEX_WORK_HAD_VECTOR_KEY] === true;
}

/** `data` holds the stamp `work`. */
export function indexWorkIs(work: IndexWork, data: DataExpr = nodes.data): SQL {
  return sql`${indexWorkSql(data)} = ${work}`;
}

/**
 * The new nodes.data of a reset (markContentChanged only). 'embed' keeps an
 * 'extract' stamp (a content change still waits), and records whether the
 * row had a vector (the row's own, or one an earlier rename had seen).
 * 'extract' drops the summary keys `dropSummary` names.
 */
export function stampIndexWork(work: IndexWork, dropSummary: SQL): SQL {
  const data = sql`coalesce(${nodes.data}, '{}'::jsonb)`;
  if (work === 'extract') {
    return sql`(${data} - ${dropSummary} - ${STAMP_KEYS}) || jsonb_build_object(${INDEX_WORK_KEY}::text, 'extract')`;
  }
  const hadVector = sql`(${nodes.embedding} is not null
    or (${indexWorkIs('embed', data)} and ${data}->${INDEX_WORK_HAD_VECTOR_KEY}::text = 'true'::jsonb))`;
  return sql`case when ${indexWorkIs('extract', data)} then ${data}
    else ${data} || jsonb_build_object(${INDEX_WORK_KEY}::text, 'embed')
      || case when ${hadVector} then jsonb_build_object(${INDEX_WORK_HAD_VECTOR_KEY}::text, true)
              else '{}'::jsonb end
    end`;
}

/**
 * `data` without the stamp, the work being done. `seen` is the stamp the job
 * read when it loaded the row: the stamp is dropped only while it is still
 * that one, so a newer write's stamp (a content change that landed while the
 * job ran) survives for its own job. A newer stamp equal
 * to the one seen (a second content change) cannot be told apart and is
 * dropped; that change's own job still runs its whole pass (no stamp, no
 * summary).
 */
export function dropIndexWork(data: DataExpr, seen: IndexWork | null): SQL {
  const base = sql`coalesce(${data}, '{}'::jsonb)`;
  return sql`(case when ${base}->>${INDEX_WORK_KEY}::text is not distinct from ${seen}::text
    then ${base} - ${STAMP_KEYS} else ${base} end)`;
}
