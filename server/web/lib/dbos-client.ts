import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { resolveSystemDatabaseUrl } from '@mantle/assistant-runtime';

/**
 * Cached DBOSClient for enqueueing durable runner workflows (assistant turns,
 * …) from the Next.js server WITHOUT registering or running them here — the
 * apps/api process executes them. The client opens a Postgres pool against the
 * DBOS system database, so it's cached on globalThis like @mantle/db's client
 * (one pool per process, survives HMR in dev).
 *
 * Node-only (pg under the hood) — server modules only; never import from a
 * client component. Also listed in next.config serverExternalPackages so the
 * bundler leaves it external.
 */
const g = globalThis as { __mantleDbosClient?: Promise<DBOSClient> };

export function getDbosClient(): Promise<DBOSClient> {
  if (!g.__mantleDbosClient) {
    g.__mantleDbosClient = DBOSClient.create({ systemDatabaseUrl: resolveSystemDatabaseUrl() });
  }
  return g.__mantleDbosClient;
}
