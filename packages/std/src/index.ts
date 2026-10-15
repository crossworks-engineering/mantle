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
import { isProviderHttpFailure, providerFailureText } from './provider-error';

let dbErrorWatch: () => { texts: string[]; errors: unknown[] } | undefined = () => undefined;

/** Installed by '@mantle/std/db-watch' (node only), so this file stays free of
 *  node builtins and the browser bundles that import it still build. */
export function setDatabaseErrorWatch(
  get: () => { texts: string[]; errors: unknown[] } | undefined,
): void {
  dbErrorWatch = get;
}

/** The message of anything thrown: an Error's message, else its string form. */
export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const watch = dbErrorWatch();
  if (watch && text && isDatabaseError(err)) {
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
  LEVEL_CONFLICT_MESSAGE,
  NO_POLICY_ERROR,
  NO_SCOPE_ERROR,
  adminAreaError,
  editCheckRefusalError,
  editRefusalDetail,
  findDatabaseError,
  isAccessError,
  isHiddenRowsRefusal,
  isLevelConflict,
  isScopeWriteRefusal,
  mapAccessError,
  ITEM_WORKSPACE_MESSAGE,
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
  if (!isDatabaseError(err)) return err instanceof Error ? err.message : String(err);
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
 * Either way the detail is logged under `where`, server side. Anything else
 * (our own error, no provider shape) is publicErrorMessage.
 */
export function publicProviderErrorMessage(err: unknown, where: string): string {
  if (isDatabaseError(err)) return publicErrorMessage(err, where);
  const domain = domainErrorAnswer(err);
  const text = domain ? domain.toolText : providerFailureText(err);
  if (text === null) return publicErrorMessage(err, where);
  console.error(`[${where}] failed:`, err);
  return text;
}

/**
 * A tool's text for an error a builtin threw (the dispatcher's catch; A10 #10
 * fix round 2). A provider's HTTP failure ({@link isProviderHttpFailure})
 * says its fixed sentence (publicProviderErrorMessage, detail logged under
 * `where`); a domain error says its row's text (the message, for every row
 * but the provider's); anything else keeps errorMessage, as before, so a
 * database error is still collected for the surface's own check.
 */
export function toolThrowText(err: unknown, where: string): string {
  if (isProviderHttpFailure(err)) return publicProviderErrorMessage(err, where);
  const domain = domainErrorAnswer(err);
  if (domain) return domain.toolText;
  return errorMessage(err);
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
 * drizzle's "Failed query"), else unchanged. Logged in full under `where`.
 */
export function publicToolError(
  text: string,
  texts: readonly string[],
  where: string,
  errors: readonly unknown[] = [],
): string {
  const at = texts.findIndex((t) => text.includes(t));
  if (!FAILED_QUERY_RE.test(text) && at < 0) return text;
  console.error(`[${where}] database error in a tool reply:`, text);
  // The error the reply carries, read by the one mapper (databaseErrorPublic).
  return at >= 0 ? databaseErrorPublic(errors[at]) : DATABASE_ERROR_PUBLIC;
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
  PROVIDER_ERROR_PUBLIC,
  PROVIDER_ERROR_REASONS,
  ProviderHttpError,
  RETRYABLE_STATUS,
  classifyProviderError,
  isAccountError,
  isEmptyJsonBodyError,
  isProviderHttpFailure,
  isRouteDownError,
  providerErrorPublicText,
  providerErrorStatus,
  providerFailureShape,
  providerFailureText,
  retryDecision,
  type ProviderErrorClass,
  type ProviderErrorCode,
} from './provider-error';
export { CircuitBreaker } from './breaker';
