/**
 * Provider errors (A10 #10, docs/provider-http.md): THE structured error a
 * model-provider call throws on a non-2xx answer, and THE module that reads
 * a provider failure. Three questions were answered by three classifiers in
 * three packages; they live here now, over one status reader:
 *
 *  - {@link classifyProviderError}: WHAT failed, for the alert banner and the
 *    extract queue's circuit (was @mantle/embeddings provider-error.ts,
 *    2026-10-04). An account problem (no credits, a refused key, a model the
 *    provider does not offer, no key, an Anthropic key that names no
 *    workspace) is permanent; a rate limit, a server
 *    error, a network failure or a timeout is transient; anything else (a bad
 *    input, a parse error) is null: it says nothing about the provider.
 *  - {@link retryDecision}: retry this chat call now, and after how long (was
 *    classifyChatError in @mantle/voice-client retry.ts).
 *  - {@link isRouteDownError}: fail an embedding over to the backup route (was
 *    in @mantle/embeddings index.ts).
 *
 * The three keep their exact rules (each answers a different question, and
 * merging them would move a failover or a retry edge: the chat retry set has
 * 409 and 425 and not 501; failover takes any 5xx; the classifier names 408 a
 * timeout). What they now share is the reading: the status from
 * {@link ProviderHttpError} first, the adapters' message prefix after.
 *
 * `reason` and the public text are fixed sentences, never the provider's
 * body: a body can carry an account id, an organisation name or part of a
 * key. No node builtins: browser bundles import @mantle/std.
 */
import { defineDomainError } from './domain-errors';

export type ProviderErrorCode =
  | 'quota'
  | 'auth'
  | 'no_key'
  | 'workspace'
  | 'model'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout';

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
  workspace:
    'This Anthropic key is not tied to a workspace. Add the workspace id on the key, or use a key made inside an Anthropic workspace.',
  model: 'The provider does not offer this model.',
  rate_limit: 'The provider limits the request rate.',
  server: 'The provider has a server problem.',
  network: 'The brain cannot reach the provider.',
  timeout: 'The provider does not answer in time.',
};

/** What a caller hears for a provider failure the classifier cannot name. */
export const PROVIDER_ERROR_PUBLIC = 'The model provider answered with an error.';

/**
 * A model provider answered a non-2xx status. Carries the status, the
 * provider, the parsed Retry-After and the body (for the owner's logs and
 * the classifier; never shown to a caller: the domain row below answers
 * fixed text). `message` defaults to `<provider> <what> <status>: <body>`;
 * an adapter that had its own wording passes it, so log scrapers and tests
 * keep matching.
 */
export class ProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly body?: string;
  constructor(opts: {
    provider: string;
    status: number;
    body?: string;
    retryAfterMs?: number;
    /** The call, for the default message (`chat`, `embeddings`). */
    what?: string;
    message?: string;
  }) {
    super(
      opts.message ??
        `${opts.provider} ${opts.what ?? 'call'} ${opts.status}: ${(opts.body ?? '').slice(0, 400)}`,
    );
    this.name = 'ProviderHttpError';
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }

  /** The class of the failure (null: not a provider-level problem). */
  get kind(): ProviderErrorCode | null {
    return classifyProviderError(this)?.code ?? null;
  }
}

/** The fixed sentence a caller outside the server hears for `err`. */
export function providerErrorPublicText(err: ProviderHttpError): string {
  const cls = classifyProviderError(err);
  return `${cls ? cls.reason : PROVIDER_ERROR_PUBLIC} (${err.provider}, HTTP ${err.status})`;
}

defineDomainError(ProviderHttpError, {
  reason:
    'a model provider refused or failed the call the caller asked for; the text is fixed per class, never the provider body',
  status: (err) => (classifyProviderError(err)?.code === 'timeout' ? 504 : 502),
  body: (err) => ({ error: providerErrorPublicText(err) }),
  toolText: (err) => providerErrorPublicText(err),
});

/** `err` and up to three causes below it (a wrapper keeps the SDK's error
 *  as its cause: the OpenRouter chat adapter, an extractor's "embed failed"). */
function errorChain(err: unknown): object[] {
  const out: object[] = [];
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === 'object' && !out.includes(e); depth += 1) {
    out.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}

/**
 * True when `err` is a model provider's HTTP answer whose message carries the
 * provider's body: a {@link ProviderHttpError}, or an SDK's own HTTP error (a
 * numeric `statusCode` with its `body`, OpenRouter's), on the error or a
 * cause below it (A10 #10 fix round 2). Narrow on purpose: a surface that
 * also carries the caller's own errors (the tool dispatcher) maps only these,
 * so a validation message or a non-provider fetch's 404 still reads as before.
 */
export function isProviderHttpFailure(err: unknown): boolean {
  return errorChain(err).some(
    (e) =>
      e instanceof ProviderHttpError ||
      (typeof (e as { statusCode?: unknown }).statusCode === 'number' &&
        typeof (e as { body?: unknown }).body === 'string'),
  );
}

/**
 * The status of a provider failure the classifier does not name, when it is
 * one by its shape (A10 #10 fix round 2): a numeric `status` or `statusCode`
 * on the error or a cause, the adapters' message prefix, or a body that did
 * not parse (V8's SyntaxError quotes the body). `body` is the first body on
 * the chain. Null: not provider shaped, the error is the caller's own.
 */
export function providerFailureShape(err: unknown): { status?: number; body?: string } | null {
  const chain = errorChain(err);
  const body = chain
    .map((e) => (e as { body?: unknown }).body)
    .find((b): b is string => typeof b === 'string');
  const withBody = <T extends object>(o: T) => (body !== undefined ? { ...o, body } : o);
  for (const e of chain) {
    const o = e as { status?: unknown; statusCode?: unknown };
    if (typeof o.status === 'number') return withBody({ status: o.status });
    if (typeof o.statusCode === 'number') return withBody({ status: o.statusCode });
  }
  if (isProviderHttpFailure(err)) return withBody({});
  const scraped = providerErrorStatus(err);
  if (scraped !== undefined) return withBody({ status: scraped });
  if (chain.some((e) => e instanceof SyntaxError)) return {};
  return null;
}

/**
 * The provider and status of a refused key (an HTTP 401 or 403 the
 * classifier names `auth`), or null (model picker fix round 1, L2). Its
 * message carries up to 400 chars of the provider's body, and a refused
 * key's body can echo part of that key, so a log line names only these two
 * fields. A 403 that is not about the key (a moderation refusal, no
 * credits) is not one: its body stays in the log for the owner.
 */
export function providerAuthRefusal(err: unknown): { provider?: string; status: number } | null {
  let status: number | undefined;
  const cls = classifyProviderError(err);
  if (cls) {
    if (cls.code === 'auth') status = cls.status;
  } else {
    const shape = providerFailureShape(err);
    const byStatus =
      shape?.status === undefined
        ? null
        : classifyProviderError({
            status: shape.status,
            message: String((err as { message?: unknown } | null)?.message ?? ''),
            body: shape.body ?? '',
          });
    if (byStatus?.code === 'auth') status = byStatus.status;
  }
  if (status !== 401 && status !== 403) return null;
  const named = errorChain(err).find((e): e is ProviderHttpError => e instanceof ProviderHttpError);
  return named ? { provider: named.provider, status } : { status };
}

/**
 * The fixed sentence a member or the model hears for a provider failure, or
 * null when `err` is none (A10 #10 fix round 2): the classifier's class; else,
 * for one provider shaped ({@link providerFailureShape}), the class its
 * status names (an SDK keeps it as `statusCode`, which the classifier, and so
 * failover, does not read: it is read here for the text only), else
 * PROVIDER_ERROR_PUBLIC, with the status when known. Never the message.
 */
export function providerFailureText(err: unknown): string | null {
  const cls = classifyProviderError(err);
  if (cls) return cls.status ? `${cls.reason} (HTTP ${cls.status})` : cls.reason;
  const shape = providerFailureShape(err);
  if (!shape) return null;
  if (shape.status === undefined) return PROVIDER_ERROR_PUBLIC;
  const byStatus = classifyProviderError({
    status: shape.status,
    message: String((err as { message?: unknown } | null)?.message ?? ''),
    body: shape.body ?? '',
  });
  return `${byStatus ? byStatus.reason : PROVIDER_ERROR_PUBLIC} (HTTP ${shape.status})`;
}

// ── the status reader ───────────────────────────────────────────────────────

/** The HTTP status an error carries, read from structure first, else from the
 *  adapters' "<x> failed: <status> ..." / "<p> chat <status>:" prefix. */
export function providerErrorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status;
  const msg = String((err as { message?: unknown } | null)?.message ?? '');
  const m = /(?:failed|error|chat)\D{0,20}?\b([1-5]\d\d)\b/i.exec(msg);
  return m ? Number(m[1]) : undefined;
}

// ── what failed (alerts, the extract circuit) ───────────────────────────────

const PERMANENT: ReadonlySet<ProviderErrorCode> = new Set([
  'quota',
  'auth',
  'no_key',
  'workspace',
  'model',
]);

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
/**
 * Anthropic's 400 for a key not scoped to a workspace that named none: its
 * error type plus the header it asks for, not the whole sentence (the
 * wording can change; the header name is the contract). Both must be in the
 * text, so another invalid request that merely mentions a workspace is not
 * this one.
 */
const ANTHROPIC_INVALID_REQUEST_RE = /"type"\s*:\s*"invalid_request_error"/;
const ANTHROPIC_WORKSPACE_HEADER_RE = /anthropic-workspace-id/i;
const NETWORK_RE =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up|network error/i;
const TIMEOUT_RE = /ETIMEDOUT|timed? ?out/i;

/**
 * Classify a provider call's error. Null = not a provider-level problem (see
 * the module header): the caller treats it as before.
 */
export function classifyProviderError(err: unknown): ProviderErrorClass | null {
  if (err === null || err === undefined) return null;
  // A caller that wraps a provider error (the extractor: "embed failed for
  // node ...", { cause }) keeps the provider's own error as the cause: read
  // that first, so a number in the wrapper's text never decides.
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== err) {
    const inner = classifyProviderError(cause);
    if (inner) return inner;
  }
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
    if (
      status === 400 &&
      ANTHROPIC_INVALID_REQUEST_RE.test(text) &&
      ANTHROPIC_WORKSPACE_HEADER_RE.test(text)
    ) {
      return make('workspace', status);
    }
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

// ── retry now? (the chat retry wrapper) ─────────────────────────────────────

/** Transient HTTP statuses a chat call retries. */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([
  408, 409, 425, 429, 500, 502, 503, 504,
]);

/**
 * An empty or truncated 2xx body that `JSON.parse` choked on: the signature of
 * an upstream timeout or dropped connection that still returned 200 (or a
 * cut-off stream). Transient: the same request usually succeeds on retry.
 * (Caught in prod: a 16-step assistant turn died here after a 34 s upstream
 * stall returned an empty body; see openrouter-chat.ts.)
 *
 * Only the families that CANNOT arise from a complete payload match, because
 * a complete-but-invalid body is a genuine bug a retry must not mask:
 *
 *   - "Unexpected end of JSON input": `''`, whitespace, or input ending where
 *     a value was expected. Always truncation.
 *   - "Unterminated string in JSON": a string opened and never closed. Only
 *     reachable by running out of input.
 *
 * Deliberately NOT matched: `Expected ',' or '}' after property value...`,
 * `Expected ':' after property name...`, `Expected property name or '}'...`.
 * Those fire for BOTH a mid-object truncation and a malformed-but-complete
 * body, and the message alone cannot tell them apart. Retrying a real
 * malformed payload would turn one loud bug into three silent ones.
 *
 * The message strings are V8's, and V8 has changed them before. The tests
 * parse REAL malformed JSON rather than asserting hand-written strings, so the
 * next V8 wording change fails them instead of silently narrowing this again.
 */
export function isEmptyJsonBodyError(err: unknown): boolean {
  if (!(err instanceof SyntaxError)) return false;
  return (
    /unexpected end of (json )?input/i.test(err.message) ||
    /unterminated string in json/i.test(err.message)
  );
}

/** Decide whether a chat adapter error is worth retrying, and after how long. */
export function retryDecision(err: unknown): { retry: boolean; retryAfterMs?: number } {
  if (err instanceof ProviderHttpError) {
    return { retry: RETRYABLE_STATUS.has(err.status), retryAfterMs: err.retryAfterMs };
  }
  // Defensive: any error exposing a numeric HTTP status (e.g. an SDK error).
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return { retry: RETRYABLE_STATUS.has(status) };
  // The adapters' own deadline fires a TimeoutError; a bare AbortError is
  // USUALLY that deadline too. A caller's own Stop also aborts, and retrying
  // against an aborted signal just burns backoff sleeps: the chat retry
  // wrapper short-circuits that case (it can see the signal; this reader only
  // sees the error). What reaches here is transient: retry.
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return { retry: true };
  // Raw fetch network failures surface as TypeError ("fetch failed",
  // ECONNRESET, DNS, ...). The wrapper only guards a network call, so this is
  // a blip: retry.
  if (err instanceof TypeError) return { retry: true };
  // Empty/truncated JSON body: an upstream stall that returned no parseable
  // payload. Transient, and not covered by the status/network checks above.
  if (isEmptyJsonBodyError(err)) return { retry: true };
  const msg = String((err as { message?: unknown } | null)?.message ?? '');
  if (/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg)) {
    return { retry: true };
  }
  return { retry: false };
}

// ── fail over? (the embedding route failover) ───────────────────────────────

/**
 * True when an embed error means the ROUTE is unreachable: connection
 * refused, DNS failure, request timeout, or a 5xx from the server. Those are
 * safe to fail over to the same-model backup. A bad-input / 4xx error (or an
 * unsupported-input throw) returns false: a second route would not help and
 * would just burn another call. When uncertain, false (do not fail over).
 *
 * Not {@link retryDecision}: its retryable set is an explicit list, so a 501
 * or a proxy 52x (exactly what a self-hosted primary behind a tunnel answers
 * when it is down) would stop failing over.
 */
export function isRouteDownError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Native fetch network failures surface as TypeError (undici) or an
  // AbortError/TimeoutError when a deadline fires.
  if (err instanceof TypeError) return true;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;

  const m = err.message;
  if (
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|fetch failed|network|socket hang up|timed? ?out/i.test(
      m,
    )
  ) {
    return true;
  }

  // A status the error actually carries beats one scraped out of prose.
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') return status >= 500;

  // Otherwise the shape the adapters throw: "... failed: <status> <statusText>
  // ...". 5xx = server-side (route down or overloaded); 4xx = bad input (do
  // not fail over). Anchored to that prefix, because a bare /\b4\d\d\b/ also
  // fires on any three-digit number elsewhere in the message (a token count,
  // a dimension, a port).
  const reported = /(?:failed|error)\D{0,20}?\b([45]\d\d)\b/i.exec(m);
  if (reported) return reported[1]!.startsWith('5');
  return false;
}
