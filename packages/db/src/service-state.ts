/**
 * The state of an optional service (migration 0380; Sync service plan M2):
 * one sealed value per (service, key). The brain's sidecar routes are the
 * only callers (/api/sidecar/state, the service's own token); they seal and
 * open the value, so this module moves bytes only.
 *
 * Runs on the system pool, outside every scope: the runtime role holds no
 * right on the table (access-matrix.ts).
 */
import { and, asc, eq, like, sql } from 'drizzle-orm';
import { runAsActor, systemActor } from './actor';
import { systemDb } from './gateway/handles';
import { serviceState } from './schema/service-state';

/** A service slug, as a compose profile is named. */
export const SERVICE_STATE_SERVICE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A key: lowercase, digits and `:._-`, up to 200 characters. */
export const SERVICE_STATE_KEY_RE = /^[a-z0-9][a-z0-9:._-]{0,199}$/;
/** The largest sealed value (the table's check says the same). */
export const SERVICE_STATE_MAX_BYTES = 262_144;
/** The most rows one list answers. */
export const SERVICE_STATE_LIST_MAX = 1000;

const ACTOR = systemActor('service-state');

/** The sealed value at (service, key), or null. */
export async function getServiceState(service: string, key: string): Promise<Buffer | null> {
  const [row] = await systemDb
    .select({ v: serviceState.valueEnc })
    .from(serviceState)
    .where(and(eq(serviceState.service, service), eq(serviceState.key, key)))
    .limit(1);
  return row?.v ?? null;
}

/** Every (key, sealed value) of a service whose key starts with `prefix`,
 *  by key, at most SERVICE_STATE_LIST_MAX. */
export async function listServiceState(
  service: string,
  prefix: string,
): Promise<{ key: string; value: Buffer }[]> {
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  return systemDb
    .select({ key: serviceState.key, value: serviceState.valueEnc })
    .from(serviceState)
    .where(and(eq(serviceState.service, service), like(serviceState.key, `${escaped}%`)))
    .orderBy(asc(serviceState.key))
    .limit(SERVICE_STATE_LIST_MAX);
}

/** Write the sealed value at (service, key). */
export async function putServiceState(service: string, key: string, value: Buffer): Promise<void> {
  await runAsActor(ACTOR, () =>
    systemDb
      .insert(serviceState)
      .values({ service, key, valueEnc: value })
      .onConflictDoUpdate({
        target: [serviceState.service, serviceState.key],
        set: { valueEnc: value, updatedAt: sql`now()` },
      }),
  );
}

/** Remove the value at (service, key). Whether a row went. */
export async function deleteServiceState(service: string, key: string): Promise<boolean> {
  const gone = await runAsActor(ACTOR, () =>
    systemDb
      .delete(serviceState)
      .where(and(eq(serviceState.service, service), eq(serviceState.key, key)))
      .returning({ key: serviceState.key }),
  );
  return gone.length > 0;
}
