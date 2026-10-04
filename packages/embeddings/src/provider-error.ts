/**
 * Provider error classes (2026-10-04). Two brains used OpenAI direct for
 * embeddings while the account had no credits. OpenAI answered
 * `429 insufficient_quota`, which looks like a rate limit, so every extract job
 * burned five retries with backoff and then went to the dead-letter queue,
 * for days, and nobody was told.
 *
 * This module answers one question for an error thrown by a provider call:
 * is it a PERMANENT account problem (no credits, a refused key, a model the
 * provider does not offer, no key set), which no retry fixes, or a TRANSIENT
 * one (a rate limit, a server error, a network failure, a timeout), which a
 * retry with backoff does fix? Anything else (a bad input, a parse error, one
 * document the provider refuses) returns null: it says nothing about the
 * provider, so it must never pause the queue or alert an admin.
 *
 * Pure: it reads `.status`, `.body` and `.message`, so it works on the plain
 * Errors the embedding adapters throw ("<x> failed: 429 Too Many Requests -
 * <body>") and on the chat adapters' ChatHttpError alike.
 *
 * `reason` is fixed text from REASONS below, never the provider's body: an
 * admin sees it in a banner and on a phone, and a body can carry an account
 * id, an organisation name or a part of the key.
 */

export type ProviderErrorCode =
  'quota' | 'auth' | 'no_key' | 'model' | 'rate_limit' | 'server' | 'network' | 'timeout';

export interface ProviderErrorClass {
  code: ProviderErrorCode;
  /** True for an account problem a retry does not fix. */
  permanent: boolean;
  /** One plain sentence for an admin. Never provider text. */
  reason: string;
  /** The HTTP status, when the error carried one. */
  status?: number;
}

export const PROVIDER_ERROR_REASONS: Record<ProviderErrorCode, string> = {
  quota: 'The provider account has no credits or quota left.',
  auth: 'The provider refused the API key.',
  no_key: 'No API key is set for this provider.',
  model: 'The provider does not offer this model.',
  rate_limit: 'The provider limits the request rate.',
  server: 'The provider has a server problem.',
  network: 'The brain cannot reach the provider.',
  timeout: 'The provider does not answer in time.',
};

const PERMANENT: ReadonlySet<ProviderErrorCode> = new Set(['quota', 'auth', 'no_key', 'model']);

function make(code: ProviderErrorCode, status?: number): ProviderErrorClass {
  return {
    code,
    permanent: PERMANENT.has(code),
    reason: PROVIDER_ERROR_REASONS[code],
    ...(status !== undefined ? { status } : {}),
  };
}

/** A 429 or 403 body that means "the account is out of money", not "slow down". */
const QUOTA_RE =
  /insufficient_quota|insufficient[ _]credits|no credits|credits? (?:remaining|exhausted|balance)|exceeded your current quota|quota exceeded|billing|payment required|out of credits/i;
/** A 403 about this one input (OpenRouter moderation), not about the account. */
const INPUT_REFUSED_RE = /moderation|flagged|content policy|safety system/i;
/** A 400/404 about the model itself. */
const MODEL_RE =
  /model[^.]{0,80}(?:not (?:be )?found|does not exist|not exist|is not (?:a )?valid|invalid|not supported|unknown|not available)|(?:unknown|invalid) model|no endpoints found|model_not_found/i;
const NETWORK_RE =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up|network error/i;
const TIMEOUT_RE = /ETIMEDOUT|timed? ?out/i;

/** The HTTP status an error carries, read from structure first, else from the
 *  adapters' "<x> failed: <status> ..." / "<p> chat <status>:" prefix. */
export function providerErrorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status;
  const msg = String((err as { message?: unknown } | null)?.message ?? '');
  const m = /(?:failed|error|chat)\D{0,20}?\b([1-5]\d\d)\b/i.exec(msg);
  return m ? Number(m[1]) : undefined;
}

/**
 * Classify a provider call's error. Null = not a provider-level problem (see
 * the module header): the caller treats it as before.
 */
export function classifyProviderError(err: unknown): ProviderErrorClass | null {
  if (err === null || err === undefined) return null;
  const name = (err as { name?: unknown }).name;
  const msg = String((err as { message?: unknown }).message ?? err);
  const body = String((err as { body?: unknown }).body ?? '');
  const text = `${msg}\n${body}`;
  const status = providerErrorStatus(err);

  if (status !== undefined) {
    if (status === 402) return make('quota', status);
    if (status === 429) return make(QUOTA_RE.test(text) ? 'quota' : 'rate_limit', status);
    if (status === 401) return make('auth', status);
    if (status === 403) {
      if (QUOTA_RE.test(text)) return make('quota', status);
      if (INPUT_REFUSED_RE.test(text)) return null;
      return make('auth', status);
    }
    if (status === 404) return make('model', status);
    if (status === 400 || status === 422) return MODEL_RE.test(text) ? make('model', status) : null;
    if (status === 408) return make('timeout', status);
    if (status >= 500) return make('server', status);
    return null;
  }

  if (name === 'TimeoutError' || name === 'AbortError') return make('timeout');
  // Our own "no key" throws (embed, chat route resolution): a config problem
  // no retry fixes.
  if (/no api key for provider|api key for provider '[^']*' could not be resolved/i.test(msg)) {
    return make('no_key');
  }
  if (TIMEOUT_RE.test(msg)) return make('timeout');
  if (err instanceof TypeError || NETWORK_RE.test(msg)) return make('network');
  return null;
}

/** True for an account problem a second route (another provider or key)
 *  could get round: failover should try the backup. */
export function isAccountError(err: unknown): boolean {
  return classifyProviderError(err)?.permanent === true;
}
