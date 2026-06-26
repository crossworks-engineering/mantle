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

/** Resolve the DBOS system-database URL. Defaults to the same Postgres server
 *  as DATABASE_URL with the database name swapped to `mantle_dbos_sys` (DBOS
 *  creates it on first launch). Override wholesale with DBOS_SYSTEM_DATABASE_URL. */
export function resolveSystemDatabaseUrl(): string {
  const explicit = process.env.DBOS_SYSTEM_DATABASE_URL;
  if (explicit) return explicit;
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) {
    throw new Error('DATABASE_URL (or DBOS_SYSTEM_DATABASE_URL) must be set for the runner service');
  }
  const u = new URL(appUrl);
  u.pathname = '/mantle_dbos_sys';
  return u.toString();
}

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

/** The single queue all assistant/agent runners dispatch on. Concurrency caps
 *  total in-flight runs across every apps/api process (the LLM-provider
 *  backpressure valve). Override the cap with MANTLE_RUNNER_CONCURRENCY. */
export const RUNNER_QUEUE = 'mantle';
export function runnerConcurrency(): number {
  const raw = Number(process.env.MANTLE_RUNNER_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
}
