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
import { resolveSystemDatabaseUrl, RUNNER_QUEUE } from '@mantle/assistant-runtime';

// The system-DB resolver + queue name are the shared cross-process contract
// (the web enqueuer uses the same), so they live in @mantle/assistant-runtime.
// Re-exported here so the rest of apps/api keeps importing them from './config'.
export { resolveSystemDatabaseUrl, RUNNER_QUEUE };

/** Apply DBOS config. Call once, before DBOS.launch(). */
export function configureDBOS(): void {
  const tracesEndpoint = process.env.OTLP_TRACES_ENDPOINT;
  const logsEndpoint = process.env.OTLP_LOGS_ENDPOINT;
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
    logLevel: process.env.DBOS_LOG_LEVEL ?? 'info',
  });
}

/** Concurrency cap for the shared RUNNER_QUEUE — bounds total in-flight runs
 *  across every apps/api process (the LLM-provider backpressure valve).
 *  Override with MANTLE_RUNNER_CONCURRENCY. */
export function runnerConcurrency(): number {
  const raw = Number(process.env.MANTLE_RUNNER_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
}
