/**
 * Extractor: Trace-step helper for passes that run in their own trace.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { nodes } from '@mantle/db';
import { currentTrace, startTrace, step, type StepHandle } from '@mantle/tracing';

/**
 * Record a step, opening a trace first when none is active.
 *
 * `step()` bypasses entirely without a live trace — and this pass runs BEFORE
 * `extractNode` opens its `extractor_run` trace, which on a re-notify never
 * happens at all because the `already_extracted` guard returns first. So the
 * `extract_images` steps below have never reached /traces on ANY path: a
 * 453-image backfill on a live box produced zero of them, and the same zero on
 * a second brain read as "these documents have no pictures". The step calls
 * were written and simply evaporated.
 *
 * Opened LAZILY — only where there is something to record — so a text-only
 * document cannot mint an empty trace just by being looked at. `startTrace`
 * nests safely (it inherits turnId/label from a parent), so the normal
 * fresh-ingest path, which DOES have a trace by the time anything is worth
 * recording, keeps its single trace and gains a child step.
 */
export async function stepInOwnTrace<T>(
  ownerId: string,
  node: typeof nodes.$inferSelect,
  init: Parameters<typeof step<T>>[0],
  body: (handle: StepHandle) => Promise<T>,
): Promise<T> {
  if (currentTrace()) return await step(init, body);
  return await startTrace(
    {
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      data: { nodeType: node.type, title: node.title, pass: 'embedded_images' },
    },
    () => step(init, body),
  );
}
