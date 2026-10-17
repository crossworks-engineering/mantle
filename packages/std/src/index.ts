/**
 * @mantle/std — the four helpers every package used to carry its own copy of
 * (2026-09-02 audit, sloppiness A7): the error-to-message idiom appeared 322
 * times inline, the UUID regex 21 times, `sleep` twice by name and a dozen
 * times inline. No package dependencies, no node builtins (the share runtime
 * bundles this file for the browser); safe to import from anywhere. The published contract packages (client-types, content-core,
 * share-ui, voice-client) stay dependency-free and are deliberately NOT
 * consumers.
 */

/**
 * Database errors seen while a caller outside the server is being served
 * (watchDatabaseErrors): errorMessage records the text it gives for one, so
 * a tool that turned the error into a string reply can still be caught at
 * the surface (publicToolError) without touching every tool.
 */
import { DATABASE_ERROR_PUBLIC, mapAccessError } from './access-error';
import { domainErrorAnswer } from './domain-errors';
import {
  isProviderHttpFailure,
  maskKeyLiterals,
  personProviderText,
  providerAuthRefusal,
  providerFailureText,
  serviceFailureText,
} from './provider-error';

let dbErrorWatch: () => { texts: string[]; errors: unknown[] } | undefined = () => undefined;

/** Installed by '@mantle/std/db-watch' (node only), so this file stays free of
 *  node builtins and the browser bundles that import it still build. */
export function setDatabaseErrorWatch(
  get: () => { texts: string[]; errors: unknown[] } | undefined,
): void {
  dbErrorWatch = get;
}

/**
 * The message of anything thrown: an Error's message, else its string form.
 * The DETAIL form: for the server log, and for a caller's own words. Text
 * for a member or the model goes through {@link publicErrorText} (or, where
 * a surface masks, publicToolError catches a database error's, a runtime
 * fault's or a provider's HTTP failure's text this gave: each is collected
 * while the surface watches).
 */
export function errorMessage(err: unknown): string {
  const text = messageOf(err);
  const watch = dbErrorWatch();
  if (
    watch &&
    text &&
    (isDatabaseError(err) || isRuntimeFault(err) || isProviderHttpFailure(err))
  ) {
    watch.texts.push(text);
    watch.errors.push(err);
  }
  return text;
}

function databaseShaped(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { name?: unknown; code?: unknown; severity?: unknown };
  if (o.name === 'DrizzleQueryError') return true;
  return (
    typeof o.code === 'string' && /^[0-9A-Z]{5}$/.test(o.code) && typeof o.severity === 'string'
  );
}

/** Drizzle's query error message, which carries the SQL and its parameters. */
const FAILED_QUERY_RE = /Failed query:/;

/** What a caller outside the server reads for a runtime fault
 *  (RuntimeFaultError): a fixed text, the detail in the server log. */
export const RUNTIME_ERROR_PUBLIC =
  'the server could not run this request (the details are in the server log)';

/**
 * An error our own runtime raises for its plumbing (the A8 finding F2, fix
 * round 1 M2): a scope or transaction guard of @mantle/db (withSystemTx, the
 * scope runners, a lost turn scope, the actor check), the gate not being
 * ready. Its words never reach a model or a person: RUNTIME_ERROR_PUBLIC
 * goes out, the detail stays in the server log. Known by its class (the
 * `runtimeFault` mark, so a copy of this package in another bundle still
 * reads it), never by its text: a third party's output (a shell tool's
 * stderr, an MCP connector's or a peer's answer, an API tool's body) that
 * says the same words passes through, so the model can fix its call.
 */
export class RuntimeFaultError extends Error {
  readonly runtimeFault = true as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RuntimeFaultError';
  }
}

function runtimeFaultShaped(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { runtimeFault?: unknown }).runtimeFault === true;
}

/**
 * Whether `err` is a runtime fault (RuntimeFaultError, by its mark), or an
 * error wrapping one whose message repeats the fault's text (a recipe
 * step's "failed: ..."). A wrapper whose message is its own is not one, as
 * for isDatabaseError.
 */
export function isRuntimeFault(err: unknown): boolean {
  const outer: string[] = [];
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    if (runtimeFaultShaped(e)) {
      if (outer.length === 0) return true;
      const inner = (e as { message?: unknown }).message;
      return typeof inner === 'string' && inner !== '' && outer.some((m) => m.includes(inner));
    }
    const m = (e as { message?: unknown }).message;
    outer.push(typeof m === 'string' ? m : '');
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Whether `err`'s message could carry database text: a Postgres error (a
 * five-character SQLSTATE `code` and a `severity`, as postgres.js reports
 * them) or a drizzle query error (its message carries the SQL and its
 * parameters), or an error wrapping one whose message repeats the database
 * text. A wrapper of our own whose message is its own (a friendly "busy, try
 * again" over a lock timeout) is not one: its text is safe to show.
 */
export function isDatabaseError(err: unknown): boolean {
  const outer: string[] = [];
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    if (databaseShaped(e)) {
      if (outer.length === 0) return true;
      const inner = (e as { message?: unknown }).message;
      return outer.some(
        (m) =>
          FAILED_QUERY_RE.test(m) ||
          (typeof inner === 'string' && inner !== '' && m.includes(inner)),
      );
    }
    const m = (e as { message?: unknown }).message;
    outer.push(typeof m === 'string' ? m : '');
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export {
  ADMIN_KIND_CREATE_ERROR,
  ADMIN_ONLY_ERROR,
  AccessError,
  DATABASE_ERROR_PUBLIC,
  HIDDEN_ROWS_PUBLIC,
  NO_POLICY_ERROR,
  NO_SCOPE_ERROR,
  adminAreaError,
  editCheckRefusalError,
  editRefusalDetail,
  findDatabaseError,
  isAccessError,
  isHiddenRowsRefusal,
  isScopeWriteRefusal,
  mapAccessError,
  ITEM_WORKSPACE_MESSAGE,
  READ_ONLY_COPY_MESSAGE,
  ITEM_WORKSPACE_TOOL_TEXTS,
  READ_ONLY_APP_MESSAGE,
  type AccessHttp,
  type AccessKind,
  type AccessRefusal,
  type DatabaseErrorFields,
  type EditRefusalDetail,
} from './access-error';

export {
  ConflictError,
  DOMAIN_ERRORS,
  InputError,
  defineDomainError,
  domainErrorAnswer,
  itemErrorText,
  type DomainAnswer,
  type DomainErrorRow,
} from './domain-errors';

/**
 * The message of `err` for a caller outside the server (a tool reply, an MCP
 * client): a database error never goes out as its own text, which can carry
 * SQL, parameters or (with a row rule in force) something about a row the
 * caller may not read (workspaces W3, defence in depth). Logged in full
 * under `where`. A domain error says its row's text (the table the HTTP
 * answer reads, domain-errors.ts, A10 part 2). Anything else keeps its
 * message.
 */
export function publicErrorMessage(err: unknown, where: string): string {
  const domain = domainErrorAnswer(err);
  if (domain) return domain.toolText;
  if (!isDatabaseError(err)) {
    // Our runtime's own fault (a scope guard's, by its class): a fixed text
    // out, the detail in the log (the A8 finding F2). Anything else keeps
    // its message.
    if (!isRuntimeFault(err)) return err instanceof Error ? err.message : String(err);
    console.error(`[${where}] runtime fault:`, err);
    return RUNTIME_ERROR_PUBLIC;
  }
  console.error(`[${where}] database error:`, err);
  return databaseErrorPublic(err);
}

/**
 * {@link publicErrorMessage} for work that called a model provider (a team
 * turn's error, a speech, vision, image or summary tool; A10 #10 fix round
 * 1): a provider's answer can carry an account id, an organisation name or
 * part of a key, so it never reaches a member or a model. A domain error
 * (ProviderHttpError) says its row's fixed sentence; any other error the
 * provider classifier names (an SDK's own error, a timeout, a network
 * failure) says its class's fixed sentence. A provider failure the
 * classifier does not name (an OpenRouter 400 not about the model, a 403
 * moderation refusal, a 413, a body that did not parse; fix round 2) says
 * PROVIDER_ERROR_PUBLIC with its status when known, never its message.
 * Either way the detail is logged under `where`, server side, except for an
 * auth refusal (401, 403): its provider and status only. Anything else
 * (our own error, no provider shape) is publicErrorMessage.
 */
export function publicProviderErrorMessage(err: unknown, where: string, step?: StepMeta): string {
  if (isDatabaseError(err)) return publicErrorMessage(err, where);
  const domain = domainErrorAnswer(err);
  // A10 lows: the provider's sentence only on evidence of a provider failure
  // (providerFailureText); a status or a body that did not parse in work that
  // called one says a neutral fixed sentence (serviceFailureText); a
  // TypeError with no network words is our own bug: the runtime's text.
  // Before, any status, any "failed NNN", any SyntaxError and any TypeError
  // read as the provider's ("The brain cannot reach the provider.").
  const text =
    (domain ? domain.toolText : providerFailureText(err)) ??
    serviceFailureText(err) ??
    (hasTypeError(err) ? RUNTIME_ERROR_PUBLIC : null);
  if (text === null) return publicErrorMessage(err, where);
  // An auth refusal logs its provider and status only: its body can echo
  // part of the refused key (model picker fix round 1, L2).
  const refusal = providerAuthRefusal(err);
  if (refusal) {
    console.error(
      `[${where}] failed: ${refusal.provider ?? 'provider'} refused the key (HTTP ${refusal.status})`,
    );
  } else console.error(`[${where}] failed:`, err);
  step?.setMeta({ error_detail: errorDetail(err) });
  return text;
}

/**
 * {@link publicProviderErrorMessage} for a text a person reads, not the
 * model (a member's thread and stream for a failed team turn; A10 lows fix
 * round 1, L1): the same fixed sentences, except a bad-arguments 400 says
 * the neutral "The model provider refused the request." (personProviderText).
 */
export function personProviderErrorMessage(err: unknown, where: string): string {
  return personProviderText(publicProviderErrorMessage(err, where));
}

/** A step of the owner's trace (ctx.step): where the detail of a masked
 *  error goes, for the owner's debugging. */
export interface StepMeta {
  setMeta(meta: Record<string, unknown>): void;
}

function hasTypeError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; depth++) {
    if (e instanceof TypeError) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The text of a caught error for a member or the model, in one call (A10
 * lows): a model provider's HTTP failure ({@link isProviderHttpFailure})
 * says its fixed sentence (publicProviderErrorMessage, the detail logged
 * under `where` and, with `step`, kept on the owner's trace); a domain error
 * says its row's text; anything else is errorMessage, as before (a database
 * error is still collected for the surface's own check). Its pair for the
 * log and the trace is {@link errorDetail}. The helper a pinned catch
 * converts to (provider-error-gap.test.ts); no production catch calls it
 * yet: dispatch's catch spells out the same two steps (toolThrowText, then
 * the exported errorMessage, which the read-only sweep observes), so it is
 * one way among the masking and the provider tools' own calls, not the one
 * gateway (fix round 1, L3).
 */
export function publicErrorText(err: unknown, where: string, step?: StepMeta): string {
  if (isProviderHttpFailure(err)) return publicProviderErrorMessage(err, where, step);
  return domainErrorAnswer(err)?.toolText ?? errorMessage(err);
}

/**
 * The DETAIL of a caught error, for the server log and the owner's trace
 * (ctx.step setMeta): its message, except a refused key's, which names the
 * provider and status only (its body can echo part of the key). The refusal
 * is read on every error, as the log line does (A10 lows fix round 1, M1):
 * a wrapper that copied an adapter's message (`<p> embeddings failed: 401
 * Unauthorized - <body>`, `<p> chat 401: Incorrect API key provided: ...`)
 * is a refused key too, though no ProviderHttpError is left on it. Broad on
 * purpose: a 401 of our own (a Graph token) reads the same, which costs a
 * line of detail, never a key. Any other message goes out with its key
 * looking literals masked ({@link maskKeyLiterals}), the backstop for a key
 * a body echoes under another status. Never for a member or the model:
 * that is {@link publicErrorText}.
 */
export function errorDetail(err: unknown): string {
  const refusal = providerAuthRefusal(err);
  if (refusal) return `${refusal.provider ?? 'provider'} refused the key (HTTP ${refusal.status})`;
  return maskKeyLiterals(messageOf(err));
}

/** An Error's message, else the string form: errorMessage without the
 *  watch, for errorDetail. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A tool's text for an error a builtin threw (the dispatcher's catch; A10 #10
 * fix round 2), or null for the caller's errorMessage. A provider's HTTP
 * failure ({@link isProviderHttpFailure}) says its fixed sentence
 * (publicProviderErrorMessage, detail logged under `where`); a domain error
 * says its row's text (the message, for every row but the provider's).
 * Anything else is null: the caller keeps errorMessage, as before, so a
 * database error is still collected for the surface's own check.
 */
export function toolThrowText(err: unknown, where: string, step?: StepMeta): string | null {
  if (isProviderHttpFailure(err)) return publicProviderErrorMessage(err, where, step);
  return domainErrorAnswer(err)?.toolText ?? null;
}

/**
 * What a tool says for a database error: the tool text of THE one mapper
 * (mapAccessError, access-error.ts; arch A3c). An item the caller may not
 * read (the edit check's detail no_read) is "not found" (owner decision
 * D2); a folder that holds items the caller cannot move (detail
 * hidden_rows) says so in plain words; a read-only or item-workspace
 * refusal says the HTTP answer's reason (A5 step 5, owner decision Q3 b);
 * any other database error is DATABASE_ERROR_PUBLIC, never its text.
 */
export function databaseErrorPublic(err: unknown): string {
  return mapAccessError(err)?.toolText ?? DATABASE_ERROR_PUBLIC;
}

/**
 * A tool's error text for a caller outside the server: generic when it
 * carries a database error's text (one collected by watchDatabaseErrors, or
 * drizzle's "Failed query"), RUNTIME_ERROR_PUBLIC when it carries a
 * runtime fault's text (a RuntimeFaultError errorMessage gave during the
 * call, collected the same way), else unchanged: a third party's words
 * pass through. Logged in full under `where`. With `step` (the call's
 * trace step, where the surface has one: dispatch's masking), a provider
 * failure's detail lands on the owner's trace as `error_detail`
 * (errorDetail; A10 lows fix round 1, L2).
 */
export function publicToolError(
  text: string,
  texts: readonly string[],
  where: string,
  errors: readonly unknown[] = [],
  step?: StepMeta,
): string {
  const at = texts.findIndex((t) => text.includes(t));
  if (!FAILED_QUERY_RE.test(text) && at < 0) return text;
  if (at >= 0 && isWatchedProviderFailure(errors[at])) {
    // A provider's HTTP failure a tool caught and replied with (A10 lows):
    // its fixed sentence, never the body (logged under `where`).
    return publicProviderErrorMessage(errors[at], where, step);
  }
  if (at >= 0 && !isDatabaseError(errors[at]) && isRuntimeFault(errors[at])) {
    // A runtime fault's text the reply repeats (the A8 finding F2).
    console.error(`[${where}] runtime fault in a tool reply:`, text);
    return RUNTIME_ERROR_PUBLIC;
  }
  console.error(`[${where}] database error in a tool reply:`, text);
  // The error the reply carries, read by the one mapper (databaseErrorPublic).
  return at >= 0 ? databaseErrorPublic(errors[at]) : DATABASE_ERROR_PUBLIC;
}

/** An error the watch collected for being a provider's HTTP failure (and
 *  not a database error or a runtime fault, which their own mappers read). */
export function isWatchedProviderFailure(err: unknown): boolean {
  return !isDatabaseError(err) && !isRuntimeFault(err) && isProviderHttpFailure(err);
}

/** Canonical UUID shape (any version, either case). Postgres accepts both
 *  cases, so do we; anchor it and it is safe to use on untrusted input. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cap a string at `max` characters, marking the cut with an ellipsis that
 * COUNTS toward the cap — so the result is never longer than `max`, which is
 * what a caller passing a column width or a column's storage limit needs.
 *
 * The 2026-09 audit counted five `truncate` definitions and called them
 * duplicates. Three were: this one. The other two are a different function that
 * reports whether it cut (see `capOutput` in @mantle/tools) and belong apart.
 * Callers that also want the text on one line flatten it first — the two that
 * do disagree about whether a run of spaces collapses, and neither should
 * silently change to suit the other.
 */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export {
  backgroundFence,
  FENCE_CLOSE,
  FENCE_OPEN,
  fenceRetrieved,
  newFenceNonce,
  stripFenceMarkers,
  withFenceNote,
} from './fence';
export type { Fence } from './fence';

export {
  TimeoutError,
  backoffMs,
  formatMs,
  parseRetryAfterMs,
  timeoutSignal,
  withRetry,
  withTimeout,
  type BackoffShape,
  type RetryFailure,
  type RetryOptions,
} from './http';
export { NET_TIMEOUTS, PROVIDER_TIMEOUTS } from './timeouts';
export {
  PROVIDER_ANSWER_UNUSABLE,
  PROVIDER_ERROR_PUBLIC,
  PROVIDER_ERROR_REASONS,
  PROVIDER_REQUEST_REASONS,
  ProviderHttpError,
  SERVICE_ERROR_PUBLIC,
  UNREADABLE_ANSWER_PUBLIC,
  RETRYABLE_STATUS,
  classifyProviderError,
  isAccountError,
  isEmptyJsonBodyError,
  isProviderHttpFailure,
  isRouteDownError,
  maskKeyLiterals,
  personProviderText,
  providerErrorPublicText,
  providerErrorStatus,
  providerFailureShape,
  providerFailureText,
  providerRequestReason,
  retryDecision,
  serviceFailureText,
  type ProviderErrorClass,
  type ProviderErrorCode,
} from './provider-error';
export { CircuitBreaker } from './breaker';
export { TtlCache, type TtlCacheOptions } from './ttl-cache';
