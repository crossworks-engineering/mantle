/**
 * @mantle/std — the four helpers every package used to carry its own copy of
 * (2026-09-02 audit, sloppiness A7): the error-to-message idiom appeared 322
 * times inline, the UUID regex 21 times, `sleep` twice by name and a dozen
 * times inline. Zero dependencies; safe to import from anywhere in the
 * server tree. The published contract packages (client-types, content-core,
 * share-ui, voice-client) stay dependency-free and are deliberately NOT
 * consumers.
 */

/** The message of anything thrown: an Error's message, else its string form. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether `err` (or anything in its cause chain) came from the database: a
 * Postgres error (a five-character SQLSTATE `code` and a `severity`, as
 * postgres.js reports them) or a drizzle query error, whose message carries
 * the SQL and its parameters.
 */
export function isDatabaseError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    const o = e as { name?: unknown; code?: unknown; severity?: unknown; cause?: unknown };
    if (o.name === 'DrizzleQueryError') return true;
    if (
      typeof o.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(o.code) &&
      typeof o.severity === 'string'
    )
      return true;
    e = o.cause;
  }
  return false;
}

/** What a caller outside the server may read of a database error. */
export const DATABASE_ERROR_PUBLIC =
  'the database could not run this request (the details are in the server log)';

/**
 * The message of `err` for a caller outside the server (a tool reply, an MCP
 * client): a database error never goes out as its own text, which can carry
 * SQL, parameters or (with a row rule in force) something about a row the
 * caller may not read (workspaces W3, defence in depth). Logged in full
 * under `where`. Anything else keeps its message.
 */
export function publicErrorMessage(err: unknown, where: string): string {
  if (!isDatabaseError(err)) return errorMessage(err);
  console.error(`[${where}] database error:`, err);
  return DATABASE_ERROR_PUBLIC;
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
