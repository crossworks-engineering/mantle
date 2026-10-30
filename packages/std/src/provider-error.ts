/**
 * Provider errors (docs/provider-http.md): THE structured error a
 * model-provider call throws on a non-2xx answer, and THE module that reads
 * a provider failure. Three questions, three classifiers, one status reader:
 *
 *  - {@link classifyProviderError}: WHAT failed, for the alert banner and the
 *    extract queue's circuit. An account problem (no credits, a refused key, a model the
 *    provider does not offer, no key, an Anthropic key that names no
 *    workspace) is permanent; a rate limit, a server
 *    error, a network failure or a timeout is transient; anything else (a bad
 *    input, a parse error) is null: it says nothing about the provider.
 *  - {@link retryDecision}: retry this chat call now, and after how long.
 *  - {@link isRouteDownError}: fail an embedding over to the backup route.
 *
 * The three keep their own rules (each answers a different question, and
 * merging them would move a failover or a retry edge: the chat retry set has
 * 409 and 425 and not 501; failover takes any 5xx; the classifier names 408 a
 * timeout). What they share is the reading: the status from
 * {@link ProviderHttpError} first, the adapters' message prefix after.
 *
 * `reason` and the public text are fixed sentences, never the provider's
 * body: a body can carry an account id, an organisation name or part of a
 * key. No node builtins: browser bundles import @mantle/std.
 */
import { defineDomainError } from './domain-errors';
import { MODEL_POLICY_ERROR_NAME } from './model-policy-error';

export type ProviderErrorCode =
  | 'quota'
  /** The box policy blocks the provider or model (ModelPolicyError). */
  | 'policy'
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
  policy: "This box's policy blocks this provider or model. Choose an allowed one.",
  auth: 'The provider refused the API key.',
  no_key: 'No API key is set for this provider.',
  workspace:
    'This Anthropic key is not tied to a workspace. Add or check the workspace id on the key, or use a key made inside an Anthropic workspace.',
  model: 'The provider does not offer this model.',
  rate_limit: 'The provider limits the request rate.',
  server: 'The provider has a server problem.',
  network: 'The brain cannot reach the provider.',
  timeout: 'The provider does not answer in time.',
};

/** What a caller hears for a provider failure the classifier cannot name. */
export const PROVIDER_ERROR_PUBLIC = 'The model provider answered with an error.';

/**
 * A provider's refusal of this one request, in words the model can act on
 * too long, refused under a content policy, or bad arguments.
 * The classifier names none of these (they say nothing about the provider:
 * no alert, no failover); the sentence is picked by the status and a pattern
 * over the body, server side, and is fixed: never the body.
 *
 * `bad_request` asks the model to fix its arguments, so it is said only when
 * the body points at an argument and not at the request's own shape: a 400
 * over a tool definition, the messages or max_tokens is
 * ours to fix, and a model told to retry it would only spend calls. Any
 * other 400 or 422 says `rejected`, and so does every one a person reads
 * (a failed team turn: {@link personProviderText}).
 */
export const PROVIDER_REQUEST_REASONS = {
  too_long:
    'The request is too long for this model. Send less at once (a shorter input, fewer or smaller files) and try again.',
  refused:
    'The provider refused this input under its content policy. Rephrase it or leave out the flagged part.',
  bad_request:
    'The provider rejected the request as invalid. Check the arguments (names, types, sizes) and try again.',
  rejected: 'The model provider refused the request.',
} as const;

/** A 400 body that points at an argument the caller sent (a value, a
 *  parameter, a type), as OpenAI, Google and Anthropic word it. */
const ARGS_RE =
  /\b(?:invalid|unsupported|unknown|unrecognized)\s+(?:value|parameter|argument|field|enum)|\bargument|\bparameter|\bis required\b|\bmust be (?:one of|a |an |between|less|greater|at (?:least|most)|positive|non-negative)|\bnot one of\b|supported values|invalid_type/i;
/** A 400 about the request's own shape (the tool definitions, the messages,
 *  the output budget): never the model's arguments, whatever words it uses.
 *  In dot or bracket notation: Anthropic's `tools.0`,
 *  OpenAI's `tools[0].function.parameters` and `messages.[1].content`,
 *  Gemini's `contents.0` and `tools[0].function_declarations[0]`. */
const REQUEST_SHAPE_RE =
  /\b(?:tools|messages|contents|function_declarations)(?:\.\[?|\[)\d|\bmax_(?:completion_)?tokens\b/i;

/**
 * The text a person reads for a provider failure (a member's thread for a
 * failed team turn, its stream's error event): the model's
 * sentence, except that the bad-arguments one, which asks for a retry with
 * other arguments, says the neutral `rejected`. `text` is a fixed sentence
 * already (publicProviderErrorMessage's), never provider words.
 */
export function personProviderText(text: string): string {
  return text.replace(PROVIDER_REQUEST_REASONS.bad_request, PROVIDER_REQUEST_REASONS.rejected);
}

/** A provider answered 2xx but with no usable result (AssemblyAI's
 *  transcript status `error`, an answer the SDK could not validate). */
export const PROVIDER_ANSWER_UNUSABLE = 'The provider answered without a usable result.';

/** An input the model sent is too long (Anthropic, OpenAI, Gemini,
 *  OpenRouter wordings; a requested max_tokens is a bad argument, not this). */
const TOO_LONG_RE =
  /prompt is too long|input is too long|maximum context|context (?:length|window)|too many (?:input )?tokens|input token count|exceeds the maximum number of tokens|(?:request )?entity too large|payload too large/i;

/**
 * The fixed sentence for a request the provider refused, by its status and
 * text (message plus body, never echoed), or null for a status that is no
 * request refusal. A 2xx is an answer with no usable result.
 */
export function providerRequestReason(status: number, text: string): string | null {
  if (status >= 200 && status < 300) return PROVIDER_ANSWER_UNUSABLE;
  if (status === 413) return PROVIDER_REQUEST_REASONS.too_long;
  if (status === 403) return INPUT_REFUSED_RE.test(text) ? PROVIDER_REQUEST_REASONS.refused : null;
  if (status === 400 || status === 422) {
    if (TOO_LONG_RE.test(text)) return PROVIDER_REQUEST_REASONS.too_long;
    if (INPUT_REFUSED_RE.test(text)) return PROVIDER_REQUEST_REASONS.refused;
    return ARGS_RE.test(text) && !REQUEST_SHAPE_RE.test(text)
      ? PROVIDER_REQUEST_REASONS.bad_request
      : PROVIDER_REQUEST_REASONS.rejected;
  }
  return null;
}

/** `reason` with its status (and provider) when known; a 2xx names no status. */
function withStatus(reason: string, status?: number, provider?: string): string {
  if (status === undefined) return provider ? `${reason} (${provider})` : reason;
  if (status >= 200 && status < 300) return provider ? `${reason} (${provider})` : reason;
  return provider ? `${reason} (${provider}, HTTP ${status})` : `${reason} (HTTP ${status})`;
}

/** The sentence for a provider's HTTP answer: the class, else the request
 *  reason, else PROVIDER_ERROR_PUBLIC. `text` is read, never echoed. */
function httpReason(cls: ProviderErrorClass | null, status: number, text: string): string {
  return cls?.reason ?? providerRequestReason(status, text) ?? PROVIDER_ERROR_PUBLIC;
}

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
  const reason = httpReason(
    classifyProviderError(err),
    err.status,
    `${err.message}\n${err.body ?? ''}`,
  );
  return withStatus(reason, err.status, err.provider);
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
 * cause below it. Narrow on purpose: a surface that also carries the
 * caller's own errors (the tool dispatcher) maps only these, so a validation
 * message or a non-provider fetch's 404 keeps its own text.
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
 * one by its shape: a numeric `status` or `statusCode`
 * on the error or a cause, the adapters' message prefix, or a body that did
 * not parse (V8's SyntaxError quotes the body). `body` is the first body on
 * the chain. Null: not provider shaped, the error is the caller's own.
 *
 * Broad on purpose, and so only for the log
 * ({@link providerAuthRefusal}: a refused key's log line names provider and
 * status only, so a wrong yes costs a line of detail, never a key). The
 * public text asks for evidence instead ({@link providerFailureText}).
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
 * classifier names `auth`), or null. Its
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
 * Key looking literals in a text, each cut to its prefix plus `[masked]`:
 * the backstop under errorDetail for a body
 * that echoes a key with a status that is no refused key's (a 400 that
 * quotes the header, a 403 moderation answer that quotes the request). By
 * the providers' own key prefixes (OpenAI, Anthropic, OpenRouter `sk-`;
 * ElevenLabs `sk_`; Google `AIza`; Hugging Face `hf_`; Groq `gsk_`; xAI
 * `xai-`; Perplexity `pplx-`; Replicate `r8_`; GitHub `ghp_`, `gho_`,
 * `ghu_`, `ghs_`, `ghr_`, `github_pat_`; GitLab `glpat-`; Stripe `sk_`,
 * `rk_`; Slack `xoxb-` and kin; ours `mtlk_`), a `Bearer` or `Token` credential
 * (Deepgram's scheme), a value named `api_key`, `apikey`, `key`, `token`,
 * `secret` or `authorization` (AssemblyAI sends the bare key there), and a
 * bare key with no prefix (Mistral, Cohere, Deepgram, AssemblyAI): a run
 * of 32 or more hex characters, or of 32 or more letters and digits that
 * mixes upper case, lower case and digits. A literal starts after any
 * character that is no letter or digit, or after a percent escape, so the
 * URL-encoded `Bearer%20sk-...` is masked too. A safety
 * net, not the rule: a refused key's detail never carries its body at all.
 * `mark` replaces each literal (the MCP call log writes `[redacted]`); a
 * named value that is the mark already is left as it is.
 */
export function maskKeyLiterals(text: string, mark = '[masked]'): string {
  return text
    .replace(KEY_PREFIX_RE, (_m, prefix: string) => `${prefix}${mark}`)
    .replace(BEARER_RE, (_m, word: string, sep: string) => `${word}${sep}${mark}`)
    .replace(TOKEN_RE, (_m, word: string, sep: string) => `${word}${sep}${mark}`)
    .replace(NAMED_SECRET_RE, (m: string, name: string, sep: string, value: string) =>
      value.startsWith(mark) ? m : `${name}${sep}${mark}`,
    )
    .replace(BARE_KEY_RE, mark);
}

/** Where a literal may start: after no letter or digit, or after a `%XX`. */
const START = String.raw`(?:(?<![A-Za-z0-9])|(?<=%[0-9A-Fa-f]{2}))`;
const KEY_PREFIX_RE = new RegExp(
  String.raw`${START}(sk-|sk_|rk_|AIza|hf_|gsk_|xai-|pplx-|r8_|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|mtlk_)[A-Za-z0-9_*.-]{6,}`,
  'g',
);
const BEARER_RE = new RegExp(String.raw`${START}(Bearer)(\s+|%20)[A-Za-z0-9._~+/*-]{8,}=*`, 'gi');
/** Deepgram's `Token <key>`, when the credential has a digit (so "Token
 *  validation failed" stays). */
const TOKEN_RE = new RegExp(
  String.raw`${START}(Token)(\s+|%20)(?=[A-Za-z._~+/-]*\d)[A-Za-z0-9._~+/-]{16,}=*`,
  'gi',
);
const NAMED_SECRET_RE = new RegExp(
  String.raw`${START}(api[_-]?key|x-api-key|key|token|secret|access_token|authorization)(["']?\s*[:=]\s*["']?)([^\s"',;&}]{8,})`,
  'gi',
);
/** A key with no prefix: 32+ hex, or 32+ letters and digits that mix upper
 *  case, lower case and digits (Mistral, Cohere). */
const BARE_KEY_RE = new RegExp(
  String.raw`${START}(?:[0-9A-Fa-f]{32,}|(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{32,})(?![A-Za-z0-9])`,
  'g',
);

/**
 * The status a copy of an adapter's message carries (a wrapper that kept the
 * text but not the error): `<p> chat <status>: `, `openrouter-chat <status>
 * on `, `<p> embeddings failed: <status> <text> \u2014 `, `stream error
 * <status>: `. Narrow on purpose: our own "fetch failed: 404 Not
 * Found" or "download failed: HTTP 500" is no provider's answer.
 */
const ADAPTER_PROSE_RE =
  /(?:\bchat|\bfailed:?|\berror)\s+([1-5]\d\d)(?=:\s|\son\s|\s[A-Za-z][\w ]*\s\u2014\s)/i;

function adapterProseStatus(err: unknown): number | undefined {
  const m = ADAPTER_PROSE_RE.exec(String((err as { message?: unknown } | null)?.message ?? ''));
  return m ? Number(m[1]) : undefined;
}

/** The status on the error or a cause, as an SDK or ProviderHttpError keeps it. */
function chainStatus(err: unknown): number | undefined {
  for (const e of errorChain(err)) {
    const o = e as { status?: unknown; statusCode?: unknown };
    if (typeof o.status === 'number') return o.status;
    if (typeof o.statusCode === 'number') return o.statusCode;
  }
  return undefined;
}

/** Names a deadline or an aborted call goes by (ours, the platform's, the
 *  OpenRouter SDK's). */
const TIMEOUT_NAMES = new Set([
  'TimeoutError',
  'AbortError',
  'RequestTimeoutError',
  'RequestAbortedError',
]);

/**
 * A provider call that never got its answer, by evidence on the error or a
 * cause: a deadline's or an abort's name, a network failure's
 * words or code, the SDK's ConnectionError, undici's `terminated` (a body
 * cut off). A bare TypeError is no evidence: it is as likely our own bug.
 */
function transportFailure(err: unknown): 'timeout' | 'network' | null {
  const chain = errorChain(err);
  for (const e of chain) {
    const o = e as { name?: unknown; message?: unknown; code?: unknown };
    const name = typeof o.name === 'string' ? o.name : '';
    if (TIMEOUT_NAMES.has(name)) return 'timeout';
    if (name === 'ConnectionError') return 'network';
    if (e instanceof TypeError && /^terminated$/i.test(String(o.message))) return 'network';
    if (typeof o.code === 'string') {
      if (TIMEOUT_RE.test(o.code)) return 'timeout';
      if (NETWORK_RE.test(o.code) || o.code === 'UND_ERR_SOCKET') return 'network';
    }
  }
  // The words only when no status says an answer came ("fetch failed: 404"
  // got one).
  if (chainStatus(err) !== undefined || providerErrorStatus(err) !== undefined) return null;
  for (const e of chain) {
    const msg = String((e as { message?: unknown }).message ?? '');
    if (TIMEOUT_RE.test(msg)) return 'timeout';
    if (NETWORK_RE.test(msg)) return 'network';
  }
  return null;
}

/**
 * The fixed sentence a member or the model hears for a provider failure, or
 * null when `err` is none. It asks for evidence first, so our own errors
 * never read as the provider's:
 *
 *  - an HTTP answer: a ProviderHttpError or an SDK's own HTTP error on the
 *    chain ({@link isProviderHttpFailure}), or a copy of an adapter's
 *    message (the narrow prose shapes above). The classifier's class, else
 *    the request reason ({@link providerRequestReason}: too long, refused,
 *    bad arguments, no usable result), else PROVIDER_ERROR_PUBLIC, with the
 *    status;
 *  - a call that got no answer ({@link transportFailure}): the classifier's
 *    network or timeout class, else the one the evidence names;
 *  - our own "no API key" throw: its class.
 *
 * Never the message. An error with none of these is null: the caller
 * decides (publicProviderErrorMessage says a fixed sentence for a status, a
 * body that did not parse or a TypeError; its own text otherwise).
 */
export function providerFailureText(err: unknown): string | null {
  const http = isProviderHttpFailure(err);
  const prose = http ? undefined : adapterProseStatus(err);
  if (http || prose !== undefined) {
    const cls = classifyProviderError(err);
    if (cls) return withStatus(cls.reason, cls.status);
    const status = chainStatus(err) ?? prose ?? providerErrorStatus(err);
    if (status === undefined) return PROVIDER_ERROR_PUBLIC;
    const body = errorChain(err)
      .map((e) => (e as { body?: unknown }).body)
      .find((b): b is string => typeof b === 'string');
    const message = String((err as { message?: unknown } | null)?.message ?? '');
    const byStatus = classifyProviderError({ status, message, body: body ?? '' });
    return withStatus(httpReason(byStatus, status, `${message}\n${body ?? ''}`), status);
  }
  const transport = transportFailure(err);
  if (transport) {
    const cls = classifyProviderError(err);
    if (cls && (cls.code === 'network' || cls.code === 'timeout')) return cls.reason;
    return PROVIDER_ERROR_REASONS[transport];
  }
  const cls = classifyProviderError(err);
  if (cls?.code === 'no_key') return cls.reason;
  return null;
}

/** What a caller hears for an error that carries an HTTP status but is no
 *  model provider's answer: the status, never the text. */
export const SERVICE_ERROR_PUBLIC = 'A service the brain called answered with an error.';

/** What a caller hears for a body that did not parse (V8's SyntaxError
 *  quotes the body, so its message never goes out). */
export const UNREADABLE_ANSWER_PUBLIC = 'An answer could not be read: it is not valid JSON.';

/**
 * The fixed sentence for an error in work that called a provider that is no
 * provider failure by evidence but must still not say its text:
 * a status on the chain or in the message (the status reader's prose) says
 * SERVICE_ERROR_PUBLIC with it; a body that did not parse says
 * UNREADABLE_ANSWER_PUBLIC. Null otherwise (a TypeError is the caller's:
 * publicProviderErrorMessage treats it as a runtime fault).
 */
export function serviceFailureText(err: unknown): string | null {
  const status = chainStatus(err) ?? providerErrorStatus(err);
  if (status !== undefined) return withStatus(SERVICE_ERROR_PUBLIC, status);
  if (errorChain(err).some((e) => e instanceof SyntaxError)) return UNREADABLE_ANSWER_PUBLIC;
  return null;
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
  'policy',
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
/** A refusal of this one input (OpenRouter moderation; Azure's content
 *  filter, a 400 with code `content_filter` and "content management
 *  policy"), not about the account. */
const INPUT_REFUSED_RE =
  /moderation|flagged|content policy|safety system|content_filter|content management policy/i;
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
 * the module header): the caller handles it as its own.
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
  // The box policy's refusal (model-policy-error.ts): no call was made, and
  // no retry or other key changes it; another route may be allowed.
  if (name === MODEL_POLICY_ERROR_NAME) return make('policy');
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
