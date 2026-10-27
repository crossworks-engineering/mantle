/**
 * Extractor: a document read that took the process down is never read again
 * on its own.
 *
 * Every heavy read of an upload runs in a worker thread under limits
 * (@mantle/files isolate.ts), so a bomb costs the thread. This is the
 * backstop for a read that gets past them anyway: before a heavy read
 * starts, the node is stamped with a terminal skip, `document_too_large`,
 * carrying the pass it is in (`data.extract_skipped.reading`, and the stamp
 * that was there before as `prior`). The read finishing, well or badly,
 * puts the prior stamp back. A process that dies mid-read leaves the stamp
 * behind, durable, and so:
 *
 *  - the boot drain and the missed-event sweep leave the node alone (a
 *    current terminal skip, extractSkippedSql in @mantle/db);
 *  - the job pg-boss hands out again (an expired active job, a retry, a
 *    dead letter re-sent at boot) reaches the admission gate, which finds
 *    `reading` and records the terminal skip for good with no read
 *    ({@link crashedRead}), so it cannot take the process down twice;
 *  - the owner's re-extract of that file reads it again: the recorded skip
 *    has no `reading`, and an explicit notify always runs.
 *
 * The cost is that a process stopped for any other reason during a heavy
 * read (a roll, an unrelated crash) leaves that one document skipped with
 * the same hint, until it changes or is re-extracted. Reads take
 * milliseconds to seconds, so that is rare; the media sidecar's CAD
 * exchanges (DWG, DXF, a DWF render), which can take minutes and run in
 * another container, and Tika's, are not guarded.
 */

import { eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';

/** The heavy reads of one extraction. */
export type HeavyPass = 'tables' | 'pictures' | 'text' | 'ocr';

const PASS_LABEL: Record<HeavyPass, string> = {
  tables: 'table import',
  pictures: 'pictures',
  text: 'text',
  ocr: 'OCR page render',
};

/** Extensions whose reads are an exchange with the media sidecar, not a
 *  read in this process: never guarded. A DWF's container is read here (in
 *  a worker thread), its sheet renders by the sidecar. */
const SIDECAR_EXTS = new Set(['dwg', 'dxf']);

/** True when the `pass` read of a file of this extension is guarded. */
export function guardsRead(ext: string, pass: HeavyPass): boolean {
  if (SIDECAR_EXTS.has(ext)) return false;
  return !(ext === 'dwf' && pass === 'pictures');
}

/** {@link guardHeavyRead} when {@link guardsRead}, else `read` as is. */
export function guardedReadFor<T>(
  node: { readonly id: string },
  ext: string,
  pass: HeavyPass,
  read: () => Promise<T>,
): Promise<T> {
  return guardsRead(ext, pass) ? guardHeavyRead(node, pass, read) : read();
}

/**
 * The pass a read of this node was in when the process stopped: its
 * `reading` stamp, when it is current (at or after the node's last write;
 * new bytes make it stale). Null otherwise.
 */
export function crashedRead(node: {
  readonly data: unknown;
  readonly updatedAt: Date;
}): HeavyPass | null {
  const skipped = ((node.data ?? {}) as Record<string, unknown>).extract_skipped as
    { reading?: unknown; at?: unknown } | null | undefined;
  if (!skipped || typeof skipped.reading !== 'string') return null;
  if (!(skipped.reading in PASS_LABEL)) return null;
  const at = typeof skipped.at === 'string' ? Date.parse(skipped.at) : NaN;
  if (!(at >= node.updatedAt.getTime())) return null;
  return skipped.reading as HeavyPass;
}

/** The hint the terminal skip of a crashed read carries. */
export function crashedReadHint(pass: HeavyPass): string {
  return (
    `The server stopped while reading this file (the ${PASS_LABEL[pass]} pass), so it is ` +
    'not read again until the file changes or is re-extracted. The file stays stored and ' +
    'findable by name.'
  );
}

/** Stamp the node as being read by `pass`. Leaves `updated_at` alone; `at`
 *  is never before it, so the stamp is current. */
export async function markReading(nodeId: string, pass: HeavyPass): Promise<void> {
  await db
    .update(nodes)
    .set({
      data: sql`${nodes.data} || jsonb_build_object('extract_skipped', jsonb_build_object('reason', 'document_too_large'::text, 'at', greatest(now(), ${nodes.updatedAt}), 'reading', ${pass}::text, 'prior', ${nodes.data}->'extract_skipped'))`,
    })
    .where(eq(nodes.id, nodeId));
}

/** Put back what {@link markReading} replaced, when the stamp is still the
 *  one it wrote. */
async function clearReading(nodeId: string, pass: HeavyPass): Promise<void> {
  await db
    .update(nodes)
    .set({
      data: sql`case when ${nodes.data}->'extract_skipped'->>'reading' = ${pass}::text
        then (${nodes.data} - 'extract_skipped') || jsonb_strip_nulls(jsonb_build_object('extract_skipped', ${nodes.data}->'extract_skipped'->'prior'))
        else ${nodes.data} end`,
    })
    .where(eq(nodes.id, nodeId));
}

/**
 * Run a heavy read of `node` with the crash stamp around it. The stamp is
 * written before `read` starts (a failed write fails the extract, which is
 * retried: no read runs unstamped) and cleared after it settles, whatever
 * it did. A failed clear is logged: the node then reads as skipped until a
 * re-extract, never as read twice.
 */
export async function guardHeavyRead<T>(
  node: { readonly id: string },
  pass: HeavyPass,
  read: () => Promise<T>,
): Promise<T> {
  await markReading(node.id, pass);
  try {
    return await read();
  } finally {
    await clearReading(node.id, pass).catch((err: unknown) =>
      log('extractor').error(
        `crash-stamp clear failed for ${node.id.slice(0, 8)}:`,
        errorMessage(err),
      ),
    );
  }
}
