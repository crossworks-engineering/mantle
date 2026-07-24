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
 *
 * CRASH_TEST_SHAPE=resume runs the WP2 acceptance-gate variant instead
 * (slice-3 plan §8, TIGHTENED by the final audit): the resume workflow's
 * step shape — journaled resume_preflight (reads the claim marker, the
 * mutable state the workflow itself sets), journaled claim_resume, glue
 * (the LLM loop stand-in), journaled record_outbound. Two kill points via
 * CRASH_POINT:
 *   post_claim    — crash between claim and record_outbound (the LOSS
 *                   window; the original gate never exercised it and the
 *                   unjournaled-preflight build failed it: recovery re-read
 *                   its own claim and exited 'duplicate', outbound lost).
 *   post_outbound — crash between record_outbound and completion (the
 *                   double-post window; the original gate). DEFAULT.
 * PASS (each point) = recovery completes 'ok' with exactly one claim row
 * and exactly one outbound row. Point DATABASE_URL +
 * DBOS_SYSTEM_DATABASE_URL at SCRATCH databases so a live runner's recovery
 * never sees these workflows.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import { configureDBOS } from './config';

const MARKER = process.env.CRASH_MARKER || 'crashtest';
const CRASH = process.env.MANTLE_CRASH_TEST === '1';
/** 'resume' runs the WP2-shaped variant (preflight + claim_resume +
 *  record_outbound steps) — the slice-3 acceptance gate for the resume-loss
 *  claim. Default: the original single-step shape. */
const SHAPE = process.env.CRASH_TEST_SHAPE === 'resume' ? 'resume' : 'basic';
/** Where the resume-shape crash lands (see header): 'post_claim' = the loss
 *  window, 'post_outbound' = the double-post window (default). */
const CRASH_POINT = process.env.CRASH_POINT === 'post_claim' ? 'post_claim' : 'post_outbound';

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

/** WP2 acceptance gate (runs-slice-3-plan.md §8 amendment 2, tightened by
 *  the final audit): the resume turn's exact step ordering — a journaled
 *  PREFLIGHT that reads the claim marker (the workflow's own mutable state,
 *  the F1 hazard), a journaled claim, glue, a journaled outbound record —
 *  with the crash at CRASH_POINT. PASS = recovery replays to completion
 *  with EXACTLY ONE claim and EXACTLY ONE outbound row. */
async function crashResumeImpl(marker: string): Promise<string> {
  // resume_preflight — mirrors the workflow: the duplicate check reads state
  // the claim below mutates, so it MUST be journaled or a post-claim
  // recovery re-decides 'duplicate' and the outbound is lost.
  const preflight = await DBOS.runStep(
    async () => {
      const rows = (await db.execute(
        sql`select count(*)::int as n from _crash_test where marker = ${`${marker}:claim`}`,
      )) as unknown as Array<{ n: number }>;
      return (rows[0]?.n ?? 0) > 0 ? 'duplicate' : 'proceed';
    },
    { name: 'resume_preflight' },
  );
  if (preflight === 'duplicate') return 'duplicate';

  await DBOS.runStep(
    async () => {
      await db.execute(
        sql`insert into _crash_test (marker, at) values (${`${marker}:claim`}, now())`,
      );
      return true;
    },
    { name: 'claim_resume' },
  );

  // Glue between claim and outbound — the LLM loop stand-in and the LOSS
  // window under test.
  if (CRASH && CRASH_POINT === 'post_claim') {
    DBOS.logger.warn('[crash-test] claim committed — crashing mid-turn (loss window)');
    process.exit(137);
  }

  await DBOS.runStep(
    async () => {
      await db.execute(
        sql`insert into _crash_test (marker, at) values (${`${marker}:outbound`}, now())`,
      );
      return true;
    },
    { name: 'record_outbound' },
  );

  if (CRASH) {
    DBOS.logger.warn('[crash-test] record_outbound committed — crashing before completion');
    process.exit(137);
  }
  return 'ok';
}

const crashResumeWorkflow = DBOS.registerWorkflow(crashResumeImpl, {
  name: 'crashResumeWorkflow',
});

async function main(): Promise<void> {
  await db.execute(
    sql`create table if not exists _crash_test (id bigserial primary key, marker text, at timestamptz)`,
  );
  configureDBOS();
  await DBOS.launch(); // recovers any PENDING crashTestWorkflow for this marker

  // Same workflowID across both runs: run 2 resolves to run 1's (recovered)
  // workflow rather than starting a fresh one. The kill point is part of the
  // id so the two resume-shape gates don't collide under one marker.
  const workflow = SHAPE === 'resume' ? crashResumeWorkflow : crashTestWorkflow;
  const wfid = SHAPE === 'resume' ? `${MARKER}:${SHAPE}:${CRASH_POINT}` : `${MARKER}:${SHAPE}`;
  const handle = await DBOS.startWorkflow(workflow, { workflowID: wfid })(MARKER);

  if (!CRASH) {
    const result = await handle.getResult();
    if (SHAPE === 'resume') {
      const count = async (suffix: string) => {
        const rows = (await db.execute(
          sql`select count(*)::int as n from _crash_test where marker = ${`${MARKER}:${suffix}`}`,
        )) as unknown as Array<{ n: number }>;
        return rows[0]?.n ?? -1;
      };
      const claims = await count('claim');
      const outbounds = await count('outbound');
      console.log(`[crash-test] result=${result} claims=${claims} outbounds=${outbounds}`);
      const pass = result === 'ok' && claims === 1 && outbounds === 1;
      console.log(
        pass
          ? '[crash-test] PASS ✅ (resume shape: exactly one claim, exactly one outbound — no double-post)'
          : `[crash-test] FAIL ❌ (expected 1/1, got claims=${claims} outbounds=${outbounds})`,
      );
      await db.execute(sql`delete from _crash_test where marker like ${`${MARKER}:%`}`);
      await DBOS.shutdown();
      process.exit(pass ? 0 : 1);
    }
    const rows = (await db.execute(
      sql`select count(*)::int as n from _crash_test where marker = ${MARKER}`,
    )) as unknown as Array<{ n: number }>;
    const n = rows[0]?.n ?? -1;
    console.log(`[crash-test] result=${result} side_effect_executions=${n}`);
    console.log(
      n === 1
        ? '[crash-test] PASS ✅ (side effect ran exactly once)'
        : `[crash-test] FAIL ❌ (expected 1, got ${n})`,
    );
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
