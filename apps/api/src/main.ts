/**
 * Mantle runner service (apps/api) — the dedicated, always-on process that runs
 * durable LLM/agent work server-side so a turn never dies when the user
 * navigates away. Phase 1 stands the service up and proves the engine; it will
 * grow to host the assistant-turn runner and absorb apps/agent (Telegram +
 * background ticks). The HTTP API stays in Next.js for now (runners-first).
 *
 * On launch DBOS auto-creates its system database (if absent) and AUTO-RECOVERS
 * any workflows that were mid-flight when this process last stopped — that
 * recovery is the whole point: interrupted runs resume from their last
 * checkpointed step instead of being lost.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { configureDBOS, RUNNER_QUEUE, runnerConcurrency } from './config';
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

  const shutdown = (sig: string) => {
    DBOS.logger.info(`[api] ${sig} — shutting down`);
    void DBOS.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[api] fatal during boot:', err);
  process.exit(1);
});
