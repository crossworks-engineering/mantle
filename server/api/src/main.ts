/**
 * Mantle runner service (server/api) — the dedicated, always-on process that runs
 * durable LLM/agent work server-side so a turn never dies when the user
 * navigates away. It hosts the durable assistant-turn runner AND the absorbed
 * agent runtime (the Telegram responder, summarize/extract/heartbeat listeners,
 * and the reflector/heartbeat/extract-sweep ticks — formerly server/api). The
 * HTTP API stays in Next.js for now (runners-first).
 *
 * On launch DBOS auto-creates its system database (if absent) and AUTO-RECOVERS
 * any workflows that were mid-flight when this process last stopped — that
 * recovery is the whole point: interrupted runs resume from their last
 * checkpointed step instead of being lost.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { registerRecallEmbedder, startProcessHeartbeat } from '@mantle/content';
import { registerCanvasRenderer } from '@mantle/tools';
import { renderCanvas } from '@mantle/tools/canvas-render';
import { embedBatch } from '@mantle/embeddings';
import { runTableStorageProbes } from '@mantle/tabledb';
import { log, registerLogSink } from '@mantle/tracing';
import {
  configureDBOS,
  MEMBER_TURN_QUEUE,
  memberTurnConcurrency,
  RUNNER_QUEUE,
  runnerConcurrency,
  runsTurnConcurrency,
} from './config';
import { assertEnvShape, bootSmokeExit, isBootSmoke } from '@mantle/config';
import { openLoginWritePool, startCallAudit } from '@mantle/db';
import { ensureGateReady } from '@mantle/tools/gate-narrowers';
import { RUNS_TURN_QUEUE } from '@mantle/runs';
import { startAgentRuntime, stopAgentRuntime } from './agent/runtime';
import { installTurnStreamObserver } from './turn-stream-observer';
import { installTurnSuggestionHook } from './turn-suggestion';
import { startTurnCancelListener, stopTurnCancelListener } from './turn-cancel';
// Import workflow modules for their registration side-effects (registerWorkflow
// runs at import, before launch).
import './workflows/ping';

assertEnvShape();

// Recall's embedder. @mantle/content is storage and does not depend on the
// adapter layer, so the process that owns the adapters injects one at boot
// (packages/content/src/embed-bridge.ts). Without this, a page write that
// compiles a Recall map leaves its prompt rows un-embedded and recall_match
// silently stops finding them; the bridge throws so that shows up in the log.
// recall-embed-registration.test.ts pins this call in all three entrypoints.
registerRecallEmbedder(embedBatch);

// The canvas renderer (Present): the agent turns run here, and the tools
// that draw a canvas (present_create, present_render, diagram_render) reach
// the browser sidecar through it (packages/tools canvas-render-bridge.ts).
registerCanvasRenderer(renderCanvas);

// Route every `log(scope)` line through DBOS's logger. Inside a workflow that
// stamps the workflow id and step onto the line, which is the context you
// actually want when a durable turn goes wrong; outside one it is still the
// runner's structured logger. Processes that register nothing keep console,
// which is what a script or the web tier wants.
//
// Registered here rather than inside the agent runtime because it is a
// PROCESS-wide choice: packages/tracing is imported by the workers and the
// packages too, and they should all land in the same place.
registerLogSink(DBOS.logger);
import './workflows/assistant-turn';
import './workflows/team-turn';
// The retired client turn: a no-op under the old name, so a
// client turn still queued or in flight on this box ends cleanly.
import './workflows/client-turn-retired';
// The retired forum turn: a no-op under the old name, so a forum turn still
// queued or in flight on this box ends cleanly (see the module header).
import './workflows/forum-turn-retired';
import './workflows/runs-worker-turn';
import './workflows/runs-resume-turn';
import { enqueueTelegramTurn } from './workflows/telegram-turn';
import { env } from '@mantle/config';
import { onShutdown } from '@mantle/std/shutdown';

const agentLog = log('agent');
const apiLog = log('api');

// Backstop: every LISTEN handler and setInterval above already routes its
// errors through .catch() (the reflector + heartbeat ticks even back off),
// but a rejection that slips past should log and keep the process alive rather
// than crash-loop on a transient PostgresError (e.g. Postgres restarted and
// briefly dropped connections). Docker would bounce us anyway; staying up is
// strictly better — the listeners auto-resubscribe and the next tick recovers.
process.on('unhandledRejection', (reason) => {
  agentLog.error('unhandledRejection (kept alive):', reason);
});

async function main(): Promise<void> {
  // The one gate: every narrower registered, or
  // the boot fails here (ensureGateReady throws), not at the first tool call
  // of a turn.
  // gate-boot.test.ts pins this call in every process entry.
  ensureGateReady();
  // Boot smoke (scripts/boot-smoke.mjs): every import above linked and the
  // gate is ready; exit 0 before a pool, a listener or DBOS starts.
  if (isBootSmoke()) await bootSmokeExit('api');
  // One audit row for every tool write (@mantle/db call-audit.ts): Telegram,
  // heartbeat, team and worker turns, runs.
  startCallAudit();
  // Liveness: the api runner exposes no HTTP port (DBOS 5 has no admin
  // server), so its container healthcheck reads a heartbeat
  // file we touch on a timer. Catches a WEDGED process; a dead one is already
  // covered by the restart policy. Measures event-loop liveness, not workflow
  // progress — an idle runner with no queued turns is still healthy.
  startProcessHeartbeat();
  // This process sends scoped login writes (an Admin turn's) to
  // the write role (docs/actors.md; the connection ceiling counts its pool
  // for each process that opens it).
  openLoginWritePool();
  // Boot sanity for sqlite-native table storage: node:sqlite is experimental
  // upstream, so the engine behaviors Tables v2 relies on are re-proven on
  // every boot (this is the same suite CI runs on the prod image). Loud but
  // non-fatal — the box still serves everything else; /debug sanity mirrors
  // the failure with remediation.
  void runTableStorageProbes().then((report) => {
    if (report.ok) return;
    const failed = report.results.filter((r) => !r.ok && r.required);
    apiLog.error(
      `TABLE-STORAGE PROBES FAILED on node ${process.version} — sqlite table storage must not be used on this image:\n` +
        failed.map((r) => `  ✗ ${r.key}: ${r.detail}`).join('\n'),
    );
  });
  // Dual-mount tripwire: tool handlers run in THIS process too, so the
  // table-dbs volume must be writable here, not just in web (a tag-only
  // update that missed the compose refresh fails exactly this way).
  if (env('TABLE_DB_DIR')) {
    void import('node:fs/promises').then(async (fsp) => {
      try {
        await fsp.mkdir(env('TABLE_DB_DIR')!, { recursive: true });
        await fsp.access(env('TABLE_DB_DIR')!, 2 /* W_OK */);
      } catch {
        apiLog.error(
          `TABLE_DB_DIR (${env('TABLE_DB_DIR')}) is not writable in the api container — ` +
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
  // Post-finalize follow-up suggester (fire-and-forget, per-agent opt-in).
  // Pure registration; every real guard lives inside suggestFollowUp.
  installTurnSuggestionHook();
  // LISTEN for user "stop" requests so an in-flight streamed turn can be aborted
  // (server/web publishes the cancel; this process runs the turn). Best-effort.
  await startTurnCancelListener().catch((err) =>
    apiLog.error('turn-cancel listener failed to start (Stop will no-op):', err),
  );
  await DBOS.launch();
  // The shared runner queue — concurrency caps total in-flight runs across all
  // server/api processes (LLM-provider backpressure).
  await DBOS.registerQueue(RUNNER_QUEUE, { concurrency: runnerConcurrency() });
  // The forum's queue ('mantle_forum') is not registered. Its row persists in the DBOS system database on a box that had
  // it, so any turn left on it still dispatches, into the retired stub.
  // Dedicated queue for background runs turns (worker + resume). Off the shared
  // RUNNER_QUEUE so a run that fans out worker turns can never queue ahead of
  // the owner's interactive assistant/telegram turns (the starvation isolation;
  // see RUNS_TURN_QUEUE in @mantle/runs). Deliberately low concurrency.
  await DBOS.registerQueue(RUNS_TURN_QUEUE, { concurrency: runsTurnConcurrency() });
  // Member chat turns get their own queue too: a few busy members
  // must not queue ahead of the owner's turns. Low concurrency by default.
  await DBOS.registerQueue(MEMBER_TURN_QUEUE, { concurrency: memberTurnConcurrency() });
  // The client chat's queue ('mantle.client') is not registered. Its row
  // persists in the DBOS system database on a box
  // that had it, so any turn left on it still dispatches, into the retired
  // stub.
  DBOS.logger.info(
    `[api] runner service online — queue='${RUNNER_QUEUE}' concurrency=${runnerConcurrency()}; ` +
      `runs-turn queue='${RUNS_TURN_QUEUE}' concurrency=${runsTurnConcurrency()}; ` +
      `member-turn queue='${MEMBER_TURN_QUEUE}' concurrency=${memberTurnConcurrency()}`,
  );

  // Absorbed agent runtime: wires up the Telegram responder + background ticks
  // in this same process. Returns once its listeners + timers are live; the
  // process is kept alive by DBOS. A boot failure here is fatal (same as DBOS).
  // The Telegram responder turn runs as a durable DBOS workflow — we inject the
  // enqueuer (registered above) to keep runtime.ts free of a workflow import
  // cycle (the workflow imports handleTelegramMessage from runtime.ts).
  await startAgentRuntime({ enqueueTelegramTurn });

  // The one shutdown helper (@mantle/std/shutdown). Drain the extractor
  // queue first (finish in-flight pg-boss jobs), then stop DBOS, then exit 0;
  // a teardown past API_EXIT_DEADLINE_MS exits 1, so a hung drain never
  // holds the process.
  onShutdown({
    name: 'api',
    deadlineMs: API_EXIT_DEADLINE_MS,
    log: { info: (m) => DBOS.logger.info(m), error: (m, ...rest) => console.error(m, ...rest) },
    stop: async () => {
      await stopTurnCancelListener().catch((err) =>
        apiLog.error('stopTurnCancelListener failed:', err),
      );
      await stopAgentRuntime().catch((err) => apiLog.error('stopAgentRuntime failed:', err));
      await DBOS.shutdown();
    },
  });
}

/** The most the API's teardown may take: pg-boss drains in-flight jobs for up
 *  to its own 30 s graceful stop, then DBOS stops. Past it the process exits
 *  1 (a teardown that outlived it has failed). Under Docker the container's
 *  stop_grace_period (50 s, docker-compose.yml) gives it the room before the
 *  SIGKILL; Docker's default of 10 s would cut the drain short.
 *  compose-env.test.ts holds the grace period past this deadline. */
const API_EXIT_DEADLINE_MS = 45_000;

// No actor around the boot, so the DBOS dispatch loop carries
// none: each workflow binds its own at its entry (docs/actors.md), and one
// that forgot shows as a miss. The boot's own database work binds its own
// (startAgentRuntime: system(boot:agent-runtime)).
main().catch((err) => {
  apiLog.error('fatal during boot:', err);
  process.exit(1);
});
