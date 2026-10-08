/**
 * DBOS configuration for the dedicated Mantle runner service.
 *
 * DBOS journals every workflow + step to its own SYSTEM database (separate from
 * the app's DATABASE_URL — the system DB is pure execution bookkeeping: status,
 * timestamps, step checkpoints). On a single-VPS / local self-host that's just a
 * second database on the same Postgres server; DBOS auto-creates it on launch.
 *
 * Observability is wired here, on purpose, because EVERY runner inherits it:
 *   - built-in OpenTelemetry spans for each workflow + step (exported via OTLP
 *     when an endpoint is set; always recorded in the system DB regardless),
 *   - structured logs through DBOS.logger, correlated to the active span,
 *   - run timing + outcome queryable from WorkflowStatus (see runs.ts).
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  resolveSystemDatabaseUrl,
  RUNNER_QUEUE,
  MEMBER_TURN_QUEUE,
  CLIENT_TURN_QUEUE,
} from '@mantle/runtime/assistant';
import { env } from '@mantle/config';

// The system-DB resolver + queue name are the shared cross-process contract
// (the web enqueuer uses the same), so they live in @mantle/runtime/assistant.
// Re-exported here so the rest of server/api keeps importing them from './config'.
export { resolveSystemDatabaseUrl, RUNNER_QUEUE, MEMBER_TURN_QUEUE, CLIENT_TURN_QUEUE };

/** Apply DBOS config. Call once, before DBOS.launch(). */
export function configureDBOS(): void {
  const tracesEndpoint = env('OTLP_TRACES_ENDPOINT');
  const logsEndpoint = env('OTLP_LOGS_ENDPOINT');
  DBOS.setConfig({
    name: 'mantle-api',
    systemDatabaseUrl: resolveSystemDatabaseUrl(),
    // Built-in OTLP exporter only when an endpoint is configured; spans + run
    // records still land in the system DB either way (that's our baseline
    // observability — see runs.ts). Self-host default: no external collector.
    enableOTLP: Boolean(tracesEndpoint || logsEndpoint),
    ...(tracesEndpoint ? { otlpTracesEndpoints: [tracesEndpoint] } : {}),
    ...(logsEndpoint ? { otlpLogsEndpoints: [logsEndpoint] } : {}),
    // OTel-standard attribute naming so spans interop with any collector.
    otelAttributeFormat: 'semconv',
    logLevel: env('DBOS_LOG_LEVEL') ?? 'info',
    // Pin a STABLE application version. DBOS only auto-recovers in-flight
    // workflows within the same applicationVersion; left as the default (a code
    // hash) a deploy would strand any turn that was mid-flight. A constant means
    // a turn interrupted by a deploy resumes on the new process. Accepted
    // tradeoff (single-user, multi-second turns): if a release changes the
    // workflow's STEP SEQUENCE, replaying an old in-flight turn could diverge —
    // bump MANTLE_RUNNER_VERSION at that release to force a clean version
    // boundary (old in-flight turns then won't auto-recover; they'd be re-sent).
    applicationVersion: env('MANTLE_RUNNER_VERSION') || 'mantle-runner-1',
    // No admin server: DBOS 5 removed it. Run inspection lives in Mantle's
    // /debug and /runners, on the same WorkflowStatus data (see runs.ts).
  });
}

/** Concurrency cap for the shared RUNNER_QUEUE — bounds total in-flight runs
 *  across every server/api process (the LLM-provider backpressure valve).
 *  Override with MANTLE_RUNNER_CONCURRENCY. */
export function runnerConcurrency(): number {
  const raw = Number(env('MANTLE_RUNNER_CONCURRENCY'));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
}

/** Concurrency cap for the dedicated RUNS_TURN_QUEUE — bounds in-flight
 *  background runs turns (worker + resume) so they never queue ahead of the
 *  owner's interactive assistant/telegram turns on RUNNER_QUEUE (the
 *  starvation isolation; see RUNS_TURN_QUEUE in @mantle/runs). Deliberately
 *  low by default — background work should trickle, not flood the LLM route.
 *  Override with MANTLE_RUNS_TURN_CONCURRENCY. */
export function runsTurnConcurrency(): number {
  const raw = Number(env('MANTLE_RUNS_TURN_CONCURRENCY'));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

/** Concurrency cap for MEMBER_TURN_QUEUE: in-flight member chat turns across
 *  every member, off the owner's RUNNER_QUEUE so members never queue ahead of
 *  the owner (audit F31). Low by default; a member turn waiting a little is
 *  fine. Override with MANTLE_MEMBER_TURN_CONCURRENCY. */
export function memberTurnConcurrency(): number {
  const raw = Number(env('MANTLE_MEMBER_TURN_CONCURRENCY'));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

/** Concurrency cap for CLIENT_TURN_QUEUE (client logins C4): in-flight client
 *  chat turns across every client login, off the owner's and the members'
 *  queues. The queue is partitioned by login with one turn in flight each, so
 *  this is how many different clients are served at once. Override with
 *  MANTLE_CLIENT_TURN_CONCURRENCY. */
export function clientTurnConcurrency(): number {
  const raw = Number(env('MANTLE_CLIENT_TURN_CONCURRENCY'));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

/** The client queue's parameters: the global cap, and ONE turn in flight per
 *  partition (the client login, the enqueue's queuePartitionKey). */
export function clientTurnQueueParams(): { globalConcurrency: number; partitionConcurrency: 1 } {
  return { globalConcurrency: clientTurnConcurrency(), partitionConcurrency: 1 };
}
