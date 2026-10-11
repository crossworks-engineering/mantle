/**
 * A model route's vault key and host (workspaces W7a fix rounds 4 and 5): an
 * agent's, an AI worker's or the embedder's route sends a vault key to its
 * base URL. The key is the one its key id names, or, with no key id, the
 * provider's own vault key (the resolvers fall back to it: @mantle/runtime
 * chat-failover.ts resolveChatKey, @mantle/embeddings). A base URL left
 * empty is the provider's own host, which no login picks; a base URL set is
 * a host of the writer's choosing, so a route with a base URL always pairs a
 * key with it.
 *
 * The one rule (@mantle/tools secret-ref-gate.ts): setting a key or a
 * provider while a base URL is set, or setting or changing the base URL,
 * needs the keys area. The anchor login always may. The row records the
 * login that last paired it (configured_by, null for the anchor), and at run
 * time the key resolves only while that login holds the keys area.
 */
import { vaultPairingChanged, type VaultPairing } from '@mantle/tools';
import { toolMakerFor, vaultPairRefusalFor } from '@/lib/tools';

type Row = Record<string, unknown>;

/** The key field, the base URL field and the provider field of one route,
 *  e.g. the primary route's ['apiKeyId', 'baseUrl', 'provider']. */
export type RouteFields = readonly [keyField: string, urlField: string, providerField: string];

export const AGENT_ROUTES: readonly RouteFields[] = [
  ['apiKeyId', 'baseUrl', 'provider'],
  ['backupApiKeyId', 'backupBaseUrl', 'backupProvider'],
];

export const EMBEDDING_ROUTES: readonly RouteFields[] = [
  ['primaryApiKeyId', 'primaryBaseUrl', 'primaryProvider'],
  ['backupApiKeyId', 'backupBaseUrl', 'backupProvider'],
];

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** One route's pairing: with a base URL, its key id or else the provider's
 *  vault key, sent to that host; with none, no pairing (the provider's own
 *  host). */
export function modelRoutePairing(
  apiKeyId: unknown,
  baseUrl: unknown,
  provider: unknown,
): VaultPairing {
  const dest = text(baseUrl);
  if (!dest) return { key: '', dest };
  return { key: text(apiKeyId) || `provider:${text(provider)}`, dest };
}

/** Whether `patch` names any field of `routes`. */
export function modelRoutesTouched(patch: Row, routes: readonly RouteFields[]): boolean {
  return routes.some((fields) => fields.some((f) => f in patch));
}

/** Whether `patch` over `before` (null: a new row) sets or changes the
 *  pairing of any of `routes`. A field absent from the patch keeps the
 *  stored value. */
export function modelRoutesRepaired(
  before: Row | null,
  patch: Row,
  routes: readonly RouteFields[],
): boolean {
  return routes.some(([keyField, urlField, providerField]) => {
    const pick = (f: string) => (patch[f] !== undefined ? patch[f] : before?.[f]);
    const prev = before
      ? modelRoutePairing(before[keyField], before[urlField], before[providerField])
      : null;
    const next = modelRoutePairing(pick(keyField), pick(urlField), pick(providerField));
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

/** The configured_by stamp a permitted write of `patch` over `before`
 *  carries: the signed-in login (null for the anchor) when it pairs a key
 *  with a host, else nothing (the stored configurer stays). */
export function modelRoutesStamp(
  user: { id: string; actor: { id: string } },
  before: Row | null,
  patch: Row,
  routes: readonly RouteFields[],
): { configuredBy?: string | null } {
  return modelRoutesRepaired(before, patch, routes) ? { configuredBy: toolMakerFor(user) } : {};
}
