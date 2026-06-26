/**
 * Crash-recovery proof for the durable runner. NOT shipped — a manual harness.
 *
 * Proves the property the assistant turn relies on: a side-effecting step that
 * COMPLETED before a crash is NOT re-executed when the workflow is recovered.
 * Because hand-timing a kill inside a real ~6s LLM turn is unreliable, this uses
 * a purpose-built workflow with a deterministic crash point right after a real,
 * countable side effect (an INSERT into a temp table). It exercises the exact
 * mechanism — @mantle/tracing step()/DBOS.runStep journaling + DBOS recovery on
 * relaunch under the pinned applicationVersion.
 *
 * Run 1 (crash):    MANTLE_CRASH_TEST=1 CRASH_MARKER=<m> tsx src/crash-test.ts
 *   → side_effect step commits one INSERT, then process.exit() mid-workflow.
 * Run 2 (recover):  CRASH_MARKER=<m> tsx src/crash-test.ts
 *   → DBOS recovers the pending workflow; side_effect returns its JOURNALED
 *     result (no second INSERT); finish runs; workflow completes.
 * PASS = exactly 1 INSERT for the marker across both runs.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import { configureDBOS } from './config';

const MARKER = process.env.CRASH_MARKER || 'crashtest';
const CRASH = process.env.MANTLE_CRASH_TEST === '1';

async function crashTestImpl(marker: string): Promise<string> {
  // A real, countable side effect — journaled as a step. On recovery DBOS must
  // return this step's recorded result WITHOUT re-running the INSERT.
  await DBOS.runStep(
    async () => {
      await db.execute(sql`insert into _crash_test (marker, at) values (${marker}, now())`);
      return true;
    },
    { name: 'side_effect' },
  );

  if (CRASH) {
    DBOS.logger.warn('[crash-test] side_effect committed — simulating crash mid-workflow');
    // Hard exit: the workflow is left PENDING (not ERROR), exactly like a real
    // process crash. Run 2 (without the flag) recovers it.
    process.exit(137);
  }

  await DBOS.runStep(async () => 'done', { name: 'finish' });
  DBOS.logger.info('[crash-test] workflow completed without re-running side_effect');
  return 'ok';
}

const crashTestWorkflow = DBOS.registerWorkflow(crashTestImpl, { name: 'crashTestWorkflow' });

async function main(): Promise<void> {
  await db.execute(
    sql`create table if not exists _crash_test (id bigserial primary key, marker text, at timestamptz)`,
  );
  configureDBOS();
  await DBOS.launch(); // recovers any PENDING crashTestWorkflow for this marker

  // Same workflowID across both runs: run 2 resolves to run 1's (recovered)
  // workflow rather than starting a fresh one.
  const handle = await DBOS.startWorkflow(crashTestWorkflow, { workflowID: MARKER })(MARKER);

  if (!CRASH) {
    const result = await handle.getResult();
    const rows = (await db.execute(
      sql`select count(*)::int as n from _crash_test where marker = ${MARKER}`,
    )) as unknown as Array<{ n: number }>;
    const n = rows[0]?.n ?? -1;
    console.log(`[crash-test] result=${result} side_effect_executions=${n}`);
    console.log(n === 1 ? '[crash-test] PASS ✅ (side effect ran exactly once)' : `[crash-test] FAIL ❌ (expected 1, got ${n})`);
    await db.execute(sql`delete from _crash_test where marker = ${MARKER}`);
    await DBOS.shutdown();
    process.exit(n === 1 ? 0 : 1);
  }

  // CRASH run: wait for the workflow to reach its crash point (it will exit the
  // process itself). Guard so we don't hang forever if it didn't.
  await handle.getResult().catch(() => {});
  await DBOS.shutdown();
  process.exit(0);
}

main().catch((err) => {
  console.error('[crash-test] harness error:', err);
  process.exit(1);
});
