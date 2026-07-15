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
import { runTableStorageProbes } from '@mantle/tabledb';
import { configureDBOS, RUNNER_QUEUE, runnerConcurrency } from './config';
import { startAgentRuntime, stopAgentRuntime } from './agent/runtime';
import { installTurnStreamObserver } from './turn-stream-observer';
import { startTurnCancelListener, stopTurnCancelListener } from './turn-cancel';
// Import workflow modules for their registration side-effects (registerWorkflow
// runs at import, before launch).
import './workflows/ping';
import './workflows/assistant-turn';
import './workflows/team-turn';
import { enqueueTelegramTurn } from './workflows/telegram-turn';

async function main(): Promise<void> {
  // Boot sanity for sqlite-native table storage: node:sqlite is experimental
  // upstream, so the engine behaviors Tables v2 relies on are re-proven on
  // every boot (this is the same suite CI runs on the prod image). Loud but
  // non-fatal — the box still serves everything else; /debug sanity mirrors
  // the failure with remediation.
  void runTableStorageProbes().then((report) => {
    if (report.ok) return;
    const failed = report.results.filter((r) => !r.ok && r.required);
    console.error(
      `[api] TABLE-STORAGE PROBES FAILED on node ${process.version} — sqlite table storage must not be used on this image:\n` +
        failed.map((r) => `  ✗ ${r.key}: ${r.detail}`).join('\n'),
    );
  });
  configureDBOS();
  // Bridge trace steps → live turn-status events for streamed turns. Pure
  // registration (no I/O); harmless when MANTLE_TURN_STREAMING is off, since
  // the web SSE endpoint that relays these events is itself flag-gated.
  installTurnStreamObserver();
  // LISTEN for user "stop" requests so an in-flight streamed turn can be aborted
  // (apps/web publishes the cancel; this process runs the turn). Best-effort.
  await startTurnCancelListener().catch((err) =>
    console.error('[api] turn-cancel listener failed to start (Stop will no-op):', err),
  );
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
  // The Telegram responder turn runs as a durable DBOS workflow — we inject the
  // enqueuer (registered above) to keep runtime.ts free of a workflow import
  // cycle (the workflow imports handleTelegramMessage from runtime.ts).
  await startAgentRuntime({ enqueueTelegramTurn });

  let shuttingDown = false;
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    DBOS.logger.info(`[api] ${sig} — shutting down`);
    // Drain the extractor queue first (finish in-flight pg-boss jobs), then
    // stop DBOS, then exit.
    void stopTurnCancelListener()
      .catch((err) => console.error('[api] stopTurnCancelListener failed:', err))
      .finally(() =>
        stopAgentRuntime()
          .catch((err) => console.error('[api] stopAgentRuntime failed:', err))
          .finally(() => DBOS.shutdown().finally(() => process.exit(0))),
      );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[api] fatal during boot:', err);
  process.exit(1);
});
