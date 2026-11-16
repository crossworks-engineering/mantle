/**
 * Extractor: Trace-step helper for passes that run in their own trace.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { nodes } from '@mantle/db';
import { currentTrace, startTrace, step, type StepHandle } from '@mantle/tracing';

/**
 * Record a step of the picture pass (./images.ts), opening a trace first when
 * none is active.
 *
 * `step()` bypasses entirely without a live trace, and this pass runs in the
 * admission (./gates.ts), BEFORE the extract is admitted and opens its
 * `extractor_run` trace, which on a re-notify never happens at all because
 * the `already_extracted` guard returns first. So the steps once never
 * reached /traces: a 453-image backfill on a live box produced zero of them.
 *
 * Opened LAZILY, only where there is something to record, so a text-only
 * document cannot mint an empty trace just by being looked at. Its kind is
 * `pipeline_run` with `source: 'upload'`, as the upload's database read
 * (./auto-table.ts), never `extractor_run`: the pass runs before the extract,
 * and a reader of extracts (the sweep's `noExtractSinceWriteSql`, the
 * integrity checks) must not take it for one. Ids and fixed words only.
 * `startTrace` nests safely, so where a trace is open the step lands there.
 */
export async function stepInOwnTrace<T>(
  ownerId: string,
  node: typeof nodes.$inferSelect,
  init: Parameters<typeof step<T>>[0],
  body: (handle: StepHandle) => Promise<T>,
): Promise<T> {
  return await inOwnTrace(
    ownerId,
    node,
    { fileId: node.id, source: 'upload', pass: 'embedded_images' },
    () => step(init, body),
  );
}

/**
 * Run `fn` in the trace that is open, or, when none is, in a trace of its own
 * on the node: every step made inside lands there. The one place a pass of
 * the extract opens its own trace. The upload's database read (./auto-table.ts)
 * and the picture pass (./images.ts) run here. The kind is always
 * `pipeline_run` (with `source: 'upload'` in `data`), never `extractor_run`:
 * they run before the extract, and the readers of extracts
 * (`noExtractSinceWriteSql`, the integrity checks) must not take them for
 * one.
 */
export async function inOwnTrace<T>(
  ownerId: string,
  node: typeof nodes.$inferSelect,
  data: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  if (currentTrace()) return await fn();
  return await startTrace(
    { kind: 'pipeline_run', ownerId, subjectId: node.id, subjectKind: 'node', data },
    fn,
  );
}
