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

/** A configured chat route — which provider/model, which key, and where. */
export interface ChatRoute {
  provider: string;
  model: string;
  apiKeyId: string | null;
  /** Per-route host override (migration 0063). Blank/null = provider default.
   *  Only the `local` chat adapter reads it today; others ignore it. */
  baseUrl: string | null;
  /** Dispatch this route's HTTP through the Tailscale proxy so a `baseUrl` at a
   *  MagicDNS name reaches a NAT'd box. Inert unless the tailnet proxy is up. */
  viaTailnet: boolean;
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
  baseUrl: string | null;
  viaTailnet: boolean;
  backupProvider: string | null;
  backupModel: string | null;
  backupApiKeyId: string | null;
  backupEnabled: boolean;
  backupBaseUrl: string | null;
  backupViaTailnet: boolean;
}

/** Split a row into its active (primary) + optional backup routes. The backup
 *  is only live when enabled AND fully configured. */
export function resolveChatRoutes(row: ChatRouteRow): ChatRoutes {
  return {
    primary: {
      provider: row.provider,
      model: row.model,
      apiKeyId: row.apiKeyId ?? null,
      baseUrl: row.baseUrl ?? null,
      viaTailnet: row.viaTailnet ?? false,
    },
    backup:
      row.backupEnabled && row.backupProvider && row.backupModel
        ? {
            provider: row.backupProvider,
            model: row.backupModel,
            apiKeyId: row.backupApiKeyId ?? null,
            baseUrl: row.backupBaseUrl ?? null,
            viaTailnet: row.backupViaTailnet ?? false,
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
  /** Per-route host + tailnet flag, passed into `adapter.chat()` (migration
   *  0063). The `local` chat adapter honours them; others ignore them. */
  baseUrl: string | null;
  viaTailnet: boolean;
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
  const key = await resolveChatKey(ownerId, route);
  if (!key.ok) {
    throw new Error(
      key.disposition === 'no_api_key_id'
        ? `chat: no api key for provider '${route.provider}'. Add one at /settings/keys.`
        : `chat: api key for provider '${route.provider}' could not be resolved (${key.detail}).`,
    );
  }
  return {
    adapter,
    apiKey: key.apiKey,
    model: route.model,
    provider: route.provider,
    baseUrl: route.baseUrl ?? null,
    viaTailnet: route.viaTailnet ?? false,
  };
}

/** A route's chat credential, or a structured reason it isn't available. */
export type ChatKeyResult =
  | { ok: true; apiKey: string }
  | {
      ok: false;
      /** Stable disposition for skipped-trace rows + logs. Mirrors what the
       *  worker pre-flights have always recorded. */
      disposition: 'no_api_key_id' | 'api_key_not_decryptable';
      /** Short human detail for the log line. */
      detail: string;
    };

/**
 * THE single source of truth for "does this chat route have a usable key?" —
 * shared by the dispatch path ({@link resolveRouteAdapter}) AND every worker /
 * agent pre-flight, so the two can never drift. Resolution order mirrors the
 * dispatch exactly: route-pinned key → the provider's canonical service key →
 * the `local` keyless sentinel (a self-hosted OpenAI-compatible server needs no
 * credential). Never throws — callers decide whether a miss is fatal (the
 * dispatch throws, a worker skips with a trace).
 *
 * Adding the next keyless provider is a one-line change HERE — not a grep across
 * five worker pre-flights (which is exactly the drift that silently stopped
 * ingest when `local` workers were first configured).
 */
export async function resolveChatKey(
  ownerId: string,
  route: Pick<ChatRoute, 'provider' | 'apiKeyId'>,
): Promise<ChatKeyResult> {
  // Keyless providers: `local` needs no credential. Pinned/service keys are
  // still honoured if present (e.g. a proxy that wants a token), but their
  // absence is NOT a miss.
  const keyless = route.provider === 'local';

  let apiKey: string | null = null;
  if (route.apiKeyId) apiKey = await getApiKeyById(route.apiKeyId);
  if (!apiKey) apiKey = await getApiKey(ownerId, route.provider);
  if (apiKey) return { ok: true, apiKey };
  if (keyless) return { ok: true, apiKey: 'local' };

  // A non-keyless provider with no usable key. Distinguish "never configured"
  // from "configured but the stored key is gone / undecryptable" so traces stay
  // as informative as the old per-worker guards were.
  return route.apiKeyId
    ? {
        ok: false,
        disposition: 'api_key_not_decryptable',
        detail: `api_key_id ${route.apiKeyId} not found`,
      }
    : { ok: false, disposition: 'no_api_key_id', detail: 'no api_key_id set' };
}

/**
 * Resolve a row's BACKUP route to a callable adapter for `runToolLoop`'s
 * `backup` arg — or `undefined` when there's no backup OR it can't be resolved.
 * A broken backup (unwired provider, missing key) must NEVER break the primary
 * path: failover just won't be available, and we log why.
 */
export async function resolveBackupAdapter(
  ownerId: string,
  row: ChatRouteRow,
): Promise<ResolvedChatRoute | undefined> {
  const { backup } = resolveChatRoutes(row);
  if (!backup) return undefined;
  try {
    return await resolveRouteAdapter(ownerId, backup);
  } catch (err) {
    console.warn(
      `[chat] backup route '${backup.provider}/${backup.model}' unavailable — failover disabled: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return undefined;
  }
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
      ...(primary.baseUrl ? { baseUrl: primary.baseUrl } : {}),
      ...(primary.viaTailnet ? { viaTailnet: true } : {}),
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
      ...(backup.baseUrl ? { baseUrl: backup.baseUrl } : {}),
      ...(backup.viaTailnet ? { viaTailnet: true } : {}),
    });
    return { result, usedProvider: backup.provider, failedOver: true };
  }
}
