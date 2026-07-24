/**
 * One-shot smoke test for the runner foundation. Boots DBOS, enqueues a single
 * ping on the runner queue, waits for the result, then prints the recorded run
 * (status + the run/total durations from runs.ts) and exits. Proves the whole
 * chain — launch → system-DB journaling → queue dispatch → durable step → run
 * record with timing — without needing the long-lived service running.
 *
 *   pnpm -C apps/api smoke
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { configureDBOS, RUNNER_QUEUE, runnerConcurrency } from './config';
import { pingWorkflow } from './workflows/ping';
import { getRun } from './runs';

async function main(): Promise<void> {
  configureDBOS();
  await DBOS.launch();
  await DBOS.registerQueue(RUNNER_QUEUE, { concurrency: runnerConcurrency() });

  const handle = await DBOS.startWorkflow(pingWorkflow, { queueName: RUNNER_QUEUE })('smoke-test');
  const result = await handle.getResult();
  const run = await getRun(handle.workflowID);

  console.log('[smoke] result:', JSON.stringify(result));
  console.log('[smoke] run:', JSON.stringify(run, null, 2));

  await DBOS.shutdown();
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] failed:', err);
  process.exit(1);
});
