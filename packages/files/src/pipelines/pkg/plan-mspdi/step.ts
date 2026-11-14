/**
 * The step of `plan-mspdi`: a Microsoft Project plan saved as XML (MSPDI) to
 * its tabs Tasks, Resources and Assignments, with the description of a plan.
 * One step, one write call. It runs in the parser job `pipelineRun`.
 *
 * - No Project root: `not_mine`. An XML that is not a plan gets no name.
 *   (The core's early check on the first 8 KB, in auto-table.ts, rules most
 *   such files out before any read; this is the check on the bytes in hand.)
 * - A Project root that fails the full sniff: `ok` with no tabs, so the
 *   write spot gives the word `no-rows`, and a reader is not told "call
 *   again" for ever.
 * - Else the plan's sheets (./mspdi.ts) and the description. A file that
 *   sniffs as a plan but gives no plan (broken or empty) writes no tabs.
 */
import { FILE_TABS_WRITE, type PipelineStep } from '../../contract';
import { mspdiRootPresent, sniffMspdi } from '../../../mspdi-sniff';
import { parseMspdi } from './mspdi';

export const step: PipelineStep = async (_req, job) => {
  const bytes = await job.bytes();
  if (!mspdiRootPresent(bytes)) return { status: 'not_mine' };
  if (!sniffMspdi(bytes)) return { status: 'ok' };
  const plan = parseMspdi(bytes);
  return {
    status: 'ok',
    calls: [
      {
        call: 'tool',
        tool: FILE_TABS_WRITE,
        input: plan ? { tabs: plan.sheets, description: planDescription(plan.meta) } : { tabs: [] },
      },
    ],
  };
};

/** What a reader of a plan's tabs must know before a query. Only the
 *  ROLL-UP sentence is conditional. Gating the whole description on
 *  summaryCount left a flat plan (one with no summary rows) with no
 *  description at all, losing the unit guidance, which is true of every
 *  plan. Correct-looking and quietly less useful. */
export function planDescription(meta: { taskCount: number; summaryCount: number }): string {
  const rollup =
    meta.summaryCount > 0
      ? ` ${meta.summaryCount} of ${meta.taskCount} rows in Tasks are summary` +
        ` (roll-up) rows whose work, duration and cost ALREADY include their child tasks:` +
        ` add WHERE "Summary"=0 to any total, or the same work is counted once per outline` +
        ` level.`
      : '';
  return (
    `Microsoft Project plan.${rollup}` +
    ` Durations are hours unless the column says days; slack is in days.` +
    ` Rows are in plan order.`
  );
}
