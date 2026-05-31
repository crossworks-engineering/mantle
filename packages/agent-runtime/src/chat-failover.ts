/**
 * Chat route failover — the shared primitives for primary→backup chat routing
 * on agents and ai_workers (migration 0062).
 *
 * Unlike embeddings (vector-space-locked, same-model backup), a chat backup may
 * be a DIFFERENT provider AND model — there's no correctness cost to answering
 * on a different model. That's what lets a local model run as the primary with a
 * cloud model as the safety net (or the reverse, via the "make backup primary"
 * UI swap — which just swaps the column values, so the primary cols are always
 * the active route and the runtime needs no precedence logic).
 *
 * Failover policy (locked): try the primary; on a route-DOWN / 429 / 5xx error
 * fail over to the backup. Bad-input / auth / context-length 4xx rethrow — the
 * backup would fail identically. Switch-back is optimistic and stateless: every
 * fresh call / turn tries the primary first again (no circuit breaker).
 */
import { getApiKey, getApiKeyById } from '@mantle/api-keys';
import {
  classifyChatError,
  getChatAdapter,
  type ChatDispatcher,
  type ChatOptions,
  type ChatResult,
} from '@mantle/voice';

/** A configured chat route — which provider/model, and which key. */
export interface ChatRoute {
  provider: string;
  model: string;
  apiKeyId: string | null;
}

/** The active + optional backup routes resolved from a row. */
export interface ChatRoutes {
  primary: ChatRoute;
  backup: ChatRoute | null;
}

/** The chat-route columns shared by `agents` and `ai_workers`. */
export interface ChatRouteRow {
  provider: string;
  model: string;
  apiKeyId: string | null;
  backupProvider: string | null;
  backupModel: string | null;
  backupApiKeyId: string | null;
  backupEnabled: boolean;
}

/** Split a row into its active (primary) + optional backup routes. The backup
 *  is only live when enabled AND fully configured. */
export function resolveChatRoutes(row: ChatRouteRow): ChatRoutes {
  return {
    primary: { provider: row.provider, model: row.model, apiKeyId: row.apiKeyId ?? null },
    backup:
      row.backupEnabled && row.backupProvider && row.backupModel
        ? {
            provider: row.backupProvider,
            model: row.backupModel,
            apiKeyId: row.backupApiKeyId ?? null,
          }
        : null,
  };
}

/**
 * Should a primary-route failure fail OVER to the backup? Reuses the exact
 * transient-vs-permanent split the per-adapter retry wrapper uses (`@mantle/
 * voice`'s `classifyChatError`): route-down (network/timeout), 429, and 5xx →
 * yes; 4xx bad-input / auth / context-length → no (the backup would fail the
 * same way). The primary's own internal retries run first; this only fires once
 * those are exhausted.
 */
export function isChatFailover(err: unknown): boolean {
  return classifyChatError(err).retry;
}

/** A route resolved to a live adapter + key, ready to `.chat()`. */
export interface ResolvedChatRoute {
  adapter: ChatDispatcher;
  apiKey: string;
  model: string;
  provider: string;
}

/**
 * Resolve a {@link ChatRoute} into a callable {adapter, apiKey, model}. Route-
 * pinned key wins; falls back to the provider's canonical service key; `local`
 * is keyless (a self-hosted OpenAI-compatible chat server needs no credential).
 * Throws a clear error if the provider isn't wired or no key is available.
 */
export async function resolveRouteAdapter(
  ownerId: string,
  route: ChatRoute,
): Promise<ResolvedChatRoute> {
  const adapter = getChatAdapter(route.provider);
  if (!adapter) {
    throw new Error(`chat: no adapter registered for provider '${route.provider}'`);
  }
  let apiKey: string | null = null;
  if (route.apiKeyId) apiKey = await getApiKeyById(route.apiKeyId);
  if (!apiKey) apiKey = await getApiKey(ownerId, route.provider);
  if (!apiKey && route.provider === 'local') apiKey = 'local';
  if (!apiKey) {
    throw new Error(
      `chat: no api key for provider '${route.provider}'. Add one at /settings/keys.`,
    );
  }
  return { adapter, apiKey, model: route.model, provider: route.provider };
}

/** Chat options minus the per-route fields — `apiKey` and `model` are supplied
 *  by each route (the backup may run a different model). */
export type RoutelessChatOptions = Omit<ChatOptions, 'apiKey' | 'model'>;

export interface ChatWithFailoverResult {
  result: ChatResult;
  /** The provider that actually served the reply. */
  usedProvider: string;
  /** True when the primary failed and the backup answered. */
  failedOver: boolean;
}

/**
 * Single-shot chat with primary→backup failover — the wrapper the chat-shaped
 * workers (extractor / summarizer / reflector) use in place of a bare
 * `adapter.chat()`. Tries the primary route; on a route-DOWN / 429 / 5xx error
 * (and only if a backup is configured) resolves and calls the backup. Each call
 * starts on the primary again (optimistic, stateless switch-back).
 */
export async function chatWithFailover(
  ownerId: string,
  routes: ChatRoutes,
  opts: RoutelessChatOptions,
  log?: (msg: string) => void,
): Promise<ChatWithFailoverResult> {
  const primary = await resolveRouteAdapter(ownerId, routes.primary);
  try {
    const result = await primary.adapter.chat({
      ...opts,
      apiKey: primary.apiKey,
      model: primary.model,
    });
    return { result, usedProvider: primary.provider, failedOver: false };
  } catch (err) {
    if (!routes.backup || !isChatFailover(err)) throw err;
    log?.(
      `[chat] primary '${routes.primary.provider}/${routes.primary.model}' failed ` +
        `(${err instanceof Error ? err.message : String(err)}) — failing over to backup ` +
        `'${routes.backup.provider}/${routes.backup.model}'`,
    );
    const backup = await resolveRouteAdapter(ownerId, routes.backup);
    const result = await backup.adapter.chat({
      ...opts,
      apiKey: backup.apiKey,
      model: backup.model,
    });
    return { result, usedProvider: backup.provider, failedOver: true };
  }
}
