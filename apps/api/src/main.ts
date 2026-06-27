/**
 * Mantle runner service (apps/api) — the dedicated, always-on process that runs
 * durable LLM/agent work server-side so a turn never dies when the user
 * navigates away. It hosts the durable assistant-turn runner AND the absorbed
 * agent runtime (the Telegram responder, summarize/extract/heartbeat listeners,
 * and the reflector/heartbeat/extract-sweep ticks — formerly apps/agent). The
 * HTTP API stays in Next.js for now (runners-first).
 *
 * On launch DBOS auto-creates its system database (if absent) and AUTO-RECOVERS
 * any workflows that were mid-flight when this process last stopped — that
 * recovery is the whole point: interrupted runs resume from their last
 * checkpointed step instead of being lost.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { configureDBOS, RUNNER_QUEUE, runnerConcurrency } from './config';
import { startAgentRuntime, stopAgentRuntime } from './agent/runtime';
// Import workflow modules for their registration side-effects (registerWorkflow
// runs at import, before launch).
import './workflows/ping';
import './workflows/assistant-turn';

async function main(): Promise<void> {
  configureDBOS();
  await DBOS.launch();
  // The shared runner queue — concurrency caps total in-flight runs across all
  // apps/api processes (LLM-provider backpressure).
  await DBOS.registerQueue(RUNNER_QUEUE, { concurrency: runnerConcurrency() });
  DBOS.logger.info(
    `[api] runner service online — queue='${RUNNER_QUEUE}' concurrency=${runnerConcurrency()}`,
  );

  // Absorbed agent runtime: wires up the Telegram responder + background ticks
  // in this same process. Returns once its listeners + timers are live; the
  // process is kept alive by DBOS. A boot failure here is fatal (same as DBOS).
  await startAgentRuntime();

  let shuttingDown = false;
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    DBOS.logger.info(`[api] ${sig} — shutting down`);
    // Drain the extractor queue first (finish in-flight pg-boss jobs), then
    // stop DBOS, then exit.
    void stopAgentRuntime()
      .catch((err) => console.error('[api] stopAgentRuntime failed:', err))
      .finally(() => DBOS.shutdown().finally(() => process.exit(0)));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[api] fatal during boot:', err);
  process.exit(1);
});
