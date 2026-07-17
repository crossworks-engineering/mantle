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
import { startProcessHeartbeat } from '@mantle/content';
import { runTableStorageProbes } from '@mantle/tabledb';
import { configureDBOS, RUNNER_QUEUE, runnerConcurrency } from './config';
import { FORUM_QUEUE } from '@mantle/assistant-runtime';
import { startAgentRuntime, stopAgentRuntime } from './agent/runtime';
import { installTurnStreamObserver } from './turn-stream-observer';
import { startTurnCancelListener, stopTurnCancelListener } from './turn-cancel';
// Import workflow modules for their registration side-effects (registerWorkflow
// runs at import, before launch).
import './workflows/ping';
import './workflows/assistant-turn';
import './workflows/team-turn';
import './workflows/forum-turn';
import { enqueueTelegramTurn } from './workflows/telegram-turn';

async function main(): Promise<void> {
  // Liveness: the api runner exposes no HTTP port (the DBOS admin server is off
  // by default — see config.ts), so its container healthcheck reads a heartbeat
  // file we touch on a timer. Catches a WEDGED process; a dead one is already
  // covered by the restart policy. Measures event-loop liveness, not workflow
  // progress — an idle runner with no queued turns is still healthy.
  startProcessHeartbeat();
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
  // Dual-mount tripwire: tool handlers run in THIS process too, so the
  // table-dbs volume must be writable here, not just in web (a tag-only
  // update that missed the compose refresh fails exactly this way).
  if (process.env.TABLE_DB_DIR) {
    void import('node:fs/promises').then(async (fsp) => {
      try {
        await fsp.mkdir(process.env.TABLE_DB_DIR!, { recursive: true });
        await fsp.access(process.env.TABLE_DB_DIR!, 2 /* W_OK */);
      } catch {
        console.error(
          `[api] TABLE_DB_DIR (${process.env.TABLE_DB_DIR}) is not writable in the api container — ` +
            `agent table edits will fail. Refresh docker-compose.yml (table-dbs must be mounted into web AND api).`,
        );
      }
    });
  }
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
  // Partitioned forum queue: concurrency 1 PER PARTITION (partition key =
  // topicId) serializes turns within a topic while different topics run in
  // parallel. Off the shared RUNNER_QUEUE so a queued topic never starves the
  // owner's assistant. This replaces the old in-workflow pending spin-lock.
  await DBOS.registerQueue(FORUM_QUEUE, { concurrency: 1, partitionQueue: true });
  DBOS.logger.info(
    `[api] runner service online — queue='${RUNNER_QUEUE}' concurrency=${runnerConcurrency()}; forum queue='${FORUM_QUEUE}' (partitioned, concurrency=1/topic)`,
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
