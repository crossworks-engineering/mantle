/**
 * A model route's vault key and host (workspaces W7a fix round 4): an
 * agent's, an AI worker's or the embedder's route sends the key its key id
 * names to its base URL. A base URL left empty is the provider's own host,
 * which no login picks; a base URL set is a host of the writer's choosing.
 *
 * The one rule (@mantle/tools secret-ref-gate.ts): setting a key while a
 * base URL is set, or setting or changing the base URL while a key is set,
 * needs the keys area. The anchor login always may.
 */
import { vaultPairingChanged, type VaultPairing } from '@mantle/tools';
import { vaultPairRefusalFor } from '@/lib/tools';

type Row = Record<string, unknown>;

/** The key field and the base URL field of one route, e.g. the primary
 *  route's ['apiKeyId', 'baseUrl'] and the backup's. */
export type RouteFields = readonly [keyField: string, urlField: string];

export const AGENT_ROUTES: readonly RouteFields[] = [
  ['apiKeyId', 'baseUrl'],
  ['backupApiKeyId', 'backupBaseUrl'],
];

export const EMBEDDING_ROUTES: readonly RouteFields[] = [
  ['primaryApiKeyId', 'primaryBaseUrl'],
  ['backupApiKeyId', 'backupBaseUrl'],
];

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** One route's pairing: a key with a chosen host, or none (no key, or the
 *  provider's own host). */
export function modelRoutePairing(apiKeyId: unknown, baseUrl: unknown): VaultPairing {
  const key = text(apiKeyId);
  const dest = text(baseUrl);
  return key && dest ? { key, dest } : { key: '', dest };
}

/** Whether `patch` over `before` (null: a new row) sets or changes the
 *  pairing of any of `routes`. A field absent from the patch keeps the
 *  stored value. */
export function modelRoutesRepaired(
  before: Row | null,
  patch: Row,
  routes: readonly RouteFields[],
): boolean {
  return routes.some(([keyField, urlField]) => {
    const pick = (f: string) => (patch[f] !== undefined ? patch[f] : before?.[f]);
    const prev = before ? modelRoutePairing(before[keyField], before[urlField]) : null;
    const next = modelRoutePairing(pick(keyField), pick(urlField));
    return vaultPairingChanged(prev, next);
  });
}

/** Why the signed-in login may not write `patch` over `before`, or null. */
export async function modelRoutesRefusal(
  user: { id: string; actor: { id: string } },
  before: Row | null,
  patch: Row,
  routes: readonly RouteFields[],
): Promise<string | null> {
  if (!modelRoutesRepaired(before, patch, routes)) return null;
  return vaultPairRefusalFor(user);
}
